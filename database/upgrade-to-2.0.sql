-- 仅对已经运行过旧版 schema.sql 的 D1 数据库执行一次。
-- 本次升级：取消 50 人限制，并清空所有账号的旧打卡记录。

PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS limit_users_to_fifty;

UPDATE sync_data
SET data_json = '{"ddHistoryData":{},"ddTodos":{},"ddRecentGoals":[],"ddCheckins":{},"ddHealthData":{},"ddAlmanacRecords":{},"ddAppSettings":{}}',
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

PRAGMA optimize;
