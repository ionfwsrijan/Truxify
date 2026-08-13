import 'package:flutter_test/flutter_test.dart';
import 'package:truxify_driver/services/background_sync_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    BackgroundSyncService.scheduleTaskOverride = null;
  });

  test('registerSyncTask schedules the background sync task exactly once (issue #6281)', () {
    var scheduleCalls = 0;
    BackgroundSyncService.scheduleTaskOverride = () => scheduleCalls++;

    BackgroundSyncService.registerSyncTask();
    BackgroundSyncService.registerSyncTask();
    BackgroundSyncService.registerSyncTask();

    // Guard against duplicate scheduling: only the first call registers.
    expect(scheduleCalls, 1);
  });

  group('retry backoff (issue #11231)', () {
    test('syncRetryDelayMinutes follows the exponential ladder', () {
      expect(BackgroundSyncService.syncRetryDelayMinutes(0), 1);
      expect(BackgroundSyncService.syncRetryDelayMinutes(1), 5);
      expect(BackgroundSyncService.syncRetryDelayMinutes(2), 30);
      expect(BackgroundSyncService.syncRetryDelayMinutes(3), 120);
      expect(BackgroundSyncService.syncRetryDelayMinutes(4), 360);
      expect(BackgroundSyncService.syncRetryDelayMinutes(5), 1440);
    });

    test('syncRetryDelayMinutes caps at 24h for later retries', () {
      for (var retryCount = syncRetryBackoffMinutes.length; retryCount < maxSyncRetries; retryCount++) {
        expect(BackgroundSyncService.syncRetryDelayMinutes(retryCount), 1440);
      }
    });

    test('max retries allows at least one attempt before dead-lettering', () {
      expect(maxSyncRetries, 10);
      expect(BackgroundSyncService.syncRetryDelayMinutes(maxSyncRetries - 1), 1440);
    });
  });
}
