import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:truxify_driver/services/background_sync_service.dart';
import 'package:truxify_driver/services/pod_storage_service.dart';

/// A [PodStorageService] that never touches sqflite so tests can drive
/// [BackgroundSyncService.syncPods] without a database.
class _FakePodStorageService extends PodStorageService {
  final List<PodRecord> pods;
  final List<int> syncedIds = [];

  _FakePodStorageService(this.pods);

  @override
  Future<List<PodRecord>> getUnsyncedPods() async => pods;

  @override
  Future<int> markAsSynced(int id) async {
    syncedIds.add(id);
    return 1;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    BackgroundSyncService.scheduleTaskOverride = null;
    BackgroundSyncService.resolveTokenOverride = null;
    BackgroundSyncService.uploadPodOverride = null;
    BackgroundSyncService.apiBaseUriOverride = null;
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

  test('syncPods retries once with a fresh token after a 401 (issue #11241)', () async {
    final uploadedTokens = <String>[];
    var tokenResolutions = 0;

    BackgroundSyncService.resolveTokenOverride = () async {
      tokenResolutions += 1;
      return tokenResolutions == 1 ? 'stale-token' : 'fresh-token';
    };
    BackgroundSyncService.uploadPodOverride = (uri, pod, token) async {
      uploadedTokens.add(token);
      final status = token == 'stale-token' ? 401 : 200;
      return http.StreamedResponse(Stream<List<int>>.value(const <int>[]), status);
    };
    BackgroundSyncService.apiBaseUriOverride = Uri.parse('http://localhost:5000');

    final originalStorage = podStorageService;
    final fakeStorage = _FakePodStorageService([
      PodRecord(id: 1, orderId: 'order-11241', createdAt: 0),
    ]);
    podStorageService = fakeStorage;
    addTearDown(() => podStorageService = originalStorage);

    await BackgroundSyncService.syncPods();

    expect(uploadedTokens, ['stale-token', 'fresh-token'],
        reason: 'a 401 must re-resolve the auth token and retry the upload');
    expect(fakeStorage.syncedIds, hasLength(1),
        reason: 'the retried upload must succeed and mark the pod synced');
  });

  test('syncPods bails out without uploading when no token resolves (issue #11241)', () async {
    var uploads = 0;
    BackgroundSyncService.resolveTokenOverride = () async => null;
    BackgroundSyncService.uploadPodOverride = (uri, pod, token) async {
      uploads += 1;
      return http.StreamedResponse(Stream<List<int>>.value(const <int>[]), 200);
    };
    BackgroundSyncService.apiBaseUriOverride = Uri.parse('http://localhost:5000');

    final originalStorage = podStorageService;
    final fakeStorage = _FakePodStorageService([
      PodRecord(id: 2, orderId: 'order-11241-b', createdAt: 0),
    ]);
    podStorageService = fakeStorage;
    addTearDown(() => podStorageService = originalStorage);

    await BackgroundSyncService.syncPods();

    expect(uploads, 0,
        reason: 'without an auth token no pod may be uploaded');
    expect(fakeStorage.syncedIds, isEmpty,
        reason: 'without an auth token no pod may be marked synced');
  });
}
