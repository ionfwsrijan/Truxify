import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';
import 'dart:convert';

class PodRecord {
  final int? id;
  final String orderId;
  final String? signaturePath;
  final String? photoPath;
  final int synced;
  final int createdAt;
  final int? updatedAt;

  PodRecord({
    this.id,
    required this.orderId,
    this.signaturePath,
    this.photoPath,
    this.synced = 0,
    required this.createdAt,
    this.updatedAt,
  });

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'order_id': orderId,
      'signature_path': signaturePath,
      'photo_path': photoPath,
      'synced': synced,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }

  factory PodRecord.fromMap(Map<String, dynamic> map) {
    return PodRecord(
      id: map['id'],
      orderId: map['order_id'],
      signaturePath: map['signature_path'],
      photoPath: map['photo_path'],
      synced: map['synced'],
      createdAt: map['created_at'],
      updatedAt: map['updated_at'],
    );
  }
}

class PodStorageService {
  static Database? _database;
  static Future<Database>? _pendingInit;
  static const String tableName = 'pods';
  static const int _schemaVersion = 3;

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
      version: _schemaVersion,
      onCreate: _createDB,
      onUpgrade: _upgradeDB,
    );
  }

  Future<void> _createDB(Database db, int version) async {
    await db.execute('''
      CREATE TABLE $tableName (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        signature_path TEXT,
        photo_path TEXT,
        synced INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      )
    ''');
    await _createIndexes(db);
  }

  /// User-version based migration. sqflite tracks `PRAGMA user_version` and
  /// runs each step exactly once so existing installs upgrade in place instead
  /// of requiring an app reinstall.
  Future<void> _upgradeDB(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      await _createIndexes(db);
    }
    if (oldVersion < 3) {
      await db.execute('ALTER TABLE $tableName ADD COLUMN updated_at INTEGER');
    }
  }

  Future<void> _createIndexes(Database db) async {
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_pods_synced ON $tableName(synced)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_pods_order_id ON $tableName(order_id)',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_pods_created_at ON $tableName(created_at)',
    );
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
      {'synced': 1, 'updated_at': DateTime.now().millisecondsSinceEpoch},
      where: 'id = ?',
      whereArgs: [id],
    );
  }
}

// Mutable (not final) so tests can inject a fake instance.
PodStorageService podStorageService = PodStorageService();
