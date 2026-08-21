import { randomUUID } from 'node:crypto';

import {
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';

import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { queryCalendarChannel } from 'test/integration/utils/query-messaging.util';
import { resetCalendarChannelSyncState } from 'test/integration/utils/reset-channel-sync-state.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';

const HANDLE = 'calendar-transient-database-error@apple.dev';

// The error has to be raised by Postgres itself: an Error built in the jest
// realm is not an `instanceof Error` for the application realm the app runs in.
const raiseSqlState = (sqlState: string): string =>
  `DO $$ BEGIN RAISE EXCEPTION 'simulated database failure' USING ERRCODE = '${sqlState}'; END $$;`;

const readBackendState = async (
  backendPid: number,
): Promise<string | undefined> => {
  const activities: { state: string }[] =
    await getCoreRepository<CalendarChannelEntity>(
      CalendarChannelEntity,
    ).manager.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [
      backendPid,
    ]);

  return activities[0]?.state;
};

describe('Calendar import transient database errors (integration)', () => {
  const google = setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let calendarEventParticipantService: CalendarEventParticipantService;

  const fetchEvent = async ({
    eventId,
    title,
    attendees,
  }: {
    eventId: string;
    title: string;
    attendees: string[];
  }): Promise<void> => {
    google.serveCalendarEvents(
      [
        googleCalendarEvent({
          id: eventId,
          summary: title,
          attendees: attendees.map((email) => ({ email })),
        }),
      ],
      { nextSyncToken: `sync-token-${randomUUID()}` },
    );

    await resetCalendarChannelSyncState(channel.calendarChannelId, '');
    await runCalendarChannelListFetch(channel.calendarChannelId);
  };

  const fetchOneEvent = async (): Promise<void> => {
    await fetchEvent({
      eventId: `google-calendar-event-${randomUUID()}`,
      title: `Calendar event ${randomUUID()}`,
      attendees: [`attendee-${randomUUID()}@acme.com`],
    });
  };

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

    calendarEventParticipantService =
      getAppProviderByClassName<CalendarEventParticipantService>(
        'CalendarEventParticipantService',
      );
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should reschedule the calendar channel instead of failing it when the connection is killed by the idle-in-transaction timeout', async () => {
    await fetchOneEvent();

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async ({ transactionScope }) => {
        await transactionScope.executeRawQuery(
          raiseSqlState(
            POSTGRESQL_ERROR_CODES.IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
          ),
        );

        return [];
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.throttleFailureCount).toBe(1);
    expect(channelState.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
    );
    expect(channelState.syncStatus).toBe(CalendarChannelSyncStatus.ONGOING);
  }, 120000);

  it('should fail the calendar channel as unknown when a unique violation aborts the import transaction', async () => {
    await fetchOneEvent();

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async ({ transactionScope }) => {
        await transactionScope.executeRawQuery(
          raiseSqlState(POSTGRESQL_ERROR_CODES.UNIQUE_VIOLATION),
        );

        return [];
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.syncStatus).toBe(
      CalendarChannelSyncStatus.FAILED_UNKNOWN,
    );
    expect(channelState.syncStage).toBe(CalendarChannelSyncStage.FAILED);
    expect(channelState.throttleFailureCount).toBe(0);
  }, 120000);

  it('should reschedule the calendar channel when postgres cancels a statement inside the import transaction', async () => {
    await fetchOneEvent();

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async ({ transactionScope }) => {
        await transactionScope.executeRawQuery(
          "SET LOCAL statement_timeout = '50ms'",
        );
        await transactionScope.executeRawQuery('SELECT pg_sleep(1)');

        return [];
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.throttleFailureCount).toBe(1);
    expect(channelState.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
    );
    expect(channelState.syncStatus).toBe(CalendarChannelSyncStatus.ONGOING);
  }, 120000);

  it('should reschedule the calendar channel when the connection dies mid-transaction and the rollback fails too', async () => {
    await fetchOneEvent();

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async ({ transactionScope }) => {
        await transactionScope.executeRawQuery(
          'SELECT pg_terminate_backend(pg_backend_pid())',
        );

        return [];
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.throttleFailureCount).toBe(1);
    expect(channelState.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
    );
    expect(channelState.syncStatus).toBe(CalendarChannelSyncStatus.ONGOING);
  }, 120000);

  it('should have ended the import transaction before the contact creation job is enqueued and the participants are matched', async () => {
    await fetchOneEvent();

    const upsertAndDeleteCalendarEventParticipants =
      calendarEventParticipantService.upsertAndDeleteCalendarEventParticipants.bind(
        calendarEventParticipantService,
      );
    const matchParticipantsAndEnqueueContactCreationJob =
      calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob.bind(
        calendarEventParticipantService,
      );

    let importBackendPid: number | undefined;
    let importBackendStateWhileMatching: string | undefined;

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async (args) => {
        const backends = await args.transactionScope.executeRawQuery(
          'SELECT pg_backend_pid() AS pid',
        );

        importBackendPid = Number(backends[0].pid);

        return upsertAndDeleteCalendarEventParticipants(args);
      });

    jest
      .spyOn(
        calendarEventParticipantService,
        'matchParticipantsAndEnqueueContactCreationJob',
      )
      .mockImplementation(async (args) => {
        importBackendStateWhileMatching = await readBackendState(
          importBackendPid ?? 0,
        );

        return matchParticipantsAndEnqueueContactCreationJob(args);
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(importBackendPid).toEqual(expect.any(Number));
    expect(importBackendStateWhileMatching).toBeDefined();
    expect(importBackendStateWhileMatching).not.toBe('idle in transaction');
  }, 120000);

  it('should return only the newly saved participants without appending to the caller participant list when an existing event gains an attendee', async () => {
    const eventId = `google-calendar-event-${randomUUID()}`;
    const title = `Calendar event ${randomUUID()}`;
    const knownAttendee = `attendee-known-${randomUUID()}@acme.com`;
    const newAttendee = `attendee-new-${randomUUID()}@acme.com`;

    await fetchEvent({ eventId, title, attendees: [knownAttendee] });
    await runCalendarChannelEventsImport(channel.calendarChannelId);

    await fetchEvent({
      eventId,
      title,
      attendees: [knownAttendee, newAttendee],
    });

    const upsertAndDeleteCalendarEventParticipants =
      calendarEventParticipantService.upsertAndDeleteCalendarEventParticipants.bind(
        calendarEventParticipantService,
      );

    let participantsToCreateLengthAfterUpsert = -1;
    let savedHandles: string[] = [];

    jest
      .spyOn(
        calendarEventParticipantService,
        'upsertAndDeleteCalendarEventParticipants',
      )
      .mockImplementation(async (args) => {
        const savedParticipants =
          await upsertAndDeleteCalendarEventParticipants(args);

        participantsToCreateLengthAfterUpsert =
          args.participantsToCreate.length;
        savedHandles = savedParticipants.map(
          (participant: CalendarEventParticipantWorkspaceEntity) =>
            participant.handle ?? '',
        );

        return savedParticipants;
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(participantsToCreateLengthAfterUpsert).toBe(0);
    expect(savedHandles).toEqual([newAttendee]);
  }, 180000);
});
