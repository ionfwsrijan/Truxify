import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';
import 'dart:convert';

class PodRecord {
  final int? id;
  final String orderId;
  final String? signaturePath;
  final String? photoPath;
  final int synced;
  final int retryCount;
  final int? lastRetryAt;
  final String? lastError;
  final int createdAt;

  PodRecord({
    this.id,
    required this.orderId,
    this.signaturePath,
    this.photoPath,
    this.synced = 0,
    this.retryCount = 0,
    this.lastRetryAt,
    this.lastError,
    required this.createdAt,
  });

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'order_id': orderId,
      'signature_path': signaturePath,
      'photo_path': photoPath,
      'synced': synced,
      'retry_count': retryCount,
      'last_retry_at': lastRetryAt,
      'last_error': lastError,
      'created_at': createdAt,
    };
  }

  factory PodRecord.fromMap(Map<String, dynamic> map) {
    return PodRecord(
      id: map['id'],
      orderId: map['order_id'],
      signaturePath: map['signature_path'],
      photoPath: map['photo_path'],
      synced: map['synced'],
      retryCount: map['retry_count'] ?? 0,
      lastRetryAt: map['last_retry_at'] as int?,
      lastError: map['last_error'] as String?,
      createdAt: map['created_at'],
    );
  }
}

class PodStorageService {
  static Database? _database;
  static Future<Database>? _pendingInit;
  static const String tableName = 'pods';
  static const String deadLetterTableName = 'dead_letters';

  Future<Database> get database async {
    if (_database != null) return _database!;
    _pendingInit ??= _initDB('pods_cache.db');
    _database = await _pendingInit;
    return _database!;
  }

  Future<Database> _initDB(String filePath) async {
    final dbPath = await getDatabasesPath();
    final path = join(dbPath, filePath);

    return await openDatabase(
      path,
      version: 2,
      onCreate: _createDB,
      onUpgrade: _upgradeDB,
    );
  }

  Future _createDB(Database db, int version) async {
    await db.execute('''
      CREATE TABLE $tableName (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        signature_path TEXT,
        photo_path TEXT,
        synced INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        last_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )
    ''');
    await _createDeadLetterTable(db);
  }

  Future _upgradeDB(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      await db.execute('ALTER TABLE $tableName ADD COLUMN retry_count INTEGER DEFAULT 0');
      await db.execute('ALTER TABLE $tableName ADD COLUMN last_retry_at INTEGER');
      await db.execute('ALTER TABLE $tableName ADD COLUMN last_error TEXT');
      await _createDeadLetterTable(db);
    }
  }

  Future _createDeadLetterTable(Database db) async {
    await db.execute('''
      CREATE TABLE $deadLetterTableName (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        signature_path TEXT,
        photo_path TEXT,
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )
    ''');
  }

  Future<int> insertPod(PodRecord pod) async {
    final db = await database;
    return await db.insert(tableName, pod.toMap(), conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<List<PodRecord>> getUnsyncedPods() async {
    final db = await database;
    final List<Map<String, dynamic>> maps = await db.query(
      tableName,
      where: 'synced = ?',
      whereArgs: [0],
    );

    return List.generate(maps.length, (i) => PodRecord.fromMap(maps[i]));
  }

  Future<int> markAsSynced(int id) async {
    final db = await database;
    return await db.update(
      tableName,
      {'synced': 1},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<int> recordRetry(int id, int retryCount, int lastRetryAt, String? lastError) async {
    final db = await database;
    return await db.update(
      tableName,
      {
        'retry_count': retryCount,
        'last_retry_at': lastRetryAt,
        'last_error': lastError,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Moves a permanently failing POD to the dead-letter table so it can be
  /// reviewed manually instead of blocking the sync queue (issue #11231).
  Future<void> moveToDeadLetter(PodRecord pod) async {
    final db = await database;
    await db.transaction((txn) async {
      await txn.insert(deadLetterTableName, {
        'order_id': pod.orderId,
        'signature_path': pod.signaturePath,
        'photo_path': pod.photoPath,
        'retry_count': pod.retryCount,
        'last_error': pod.lastError,
        'created_at': pod.createdAt,
      });
      if (pod.id != null) {
        await txn.delete(
          tableName,
          where: 'id = ?',
          whereArgs: [pod.id],
        );
      }
    });
  }
}

// Mutable (not final) so tests can inject a fake instance.
PodStorageService podStorageService = PodStorageService();
