import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentId, ChatContextMode, ChatConversation, ChatMessage } from '../../shared/chat-types.js';

export function createChatStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    title TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
    session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_paper ON chat_conversations(paper_id, updated_at);
  CREATE TABLE IF NOT EXISTS chat_messages (
    ord INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(conversation_id, ord);`);
  if (!(db.prepare('PRAGMA table_info(chat_conversations)').all() as Array<{ name: string }>).some(column => column.name === 'effort'))
    db.exec("ALTER TABLE chat_conversations ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
  if (!(db.prepare('PRAGMA table_info(chat_conversations)').all() as Array<{ name: string }>).some(column => column.name === 'context_mode'))
    db.exec("ALTER TABLE chat_conversations ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'paper' CHECK(context_mode IN ('paper','general'))");
  if (!(db.prepare('PRAGMA table_info(chat_conversations)').all() as Array<{ name: string }>).some(column => column.name === 'deleted_at'))
    db.exec('ALTER TABLE chat_conversations ADD COLUMN deleted_at TEXT');
  const conversation = (row: any): ChatConversation => ({
    id: row.id, paperId: row.paper_id, title: row.title, providerId: row.provider_id,
    model: row.model, effort: row.effort, contextMode: row.context_mode, createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const get = (id: string) => {
    const row = db.prepare('SELECT * FROM chat_conversations WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) throw new Error('对话不存在');
    return conversation(row);
  };
  const messages = (id: string): ChatMessage[] => db.prepare('SELECT payload FROM chat_messages WHERE conversation_id=? ORDER BY ord').all(id)
    .map(row => JSON.parse(String(row.payload)));
  const saveMessage = (message: ChatMessage) => {
    get(message.conversationId);
    db.prepare(`INSERT INTO chat_messages(id,conversation_id,payload) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(message.id, message.conversationId, JSON.stringify(message));
    db.prepare('UPDATE chat_conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), message.conversationId);
  };
  const create = (paperId: string, providerId: AgentId, model: string, title = '新对话', effort = '', contextMode: ChatContextMode = 'paper') => {
    const id = randomUUID(), date = new Date().toISOString();
    db.prepare('INSERT INTO chat_conversations(id,paper_id,title,provider_id,model,effort,context_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, paperId, title, providerId, model, effort, contextMode, date, date);
    return get(id);
  };
  return {
    get, messages, saveMessage, create,
    exists: (id: string) => Boolean(db.prepare('SELECT 1 FROM chat_conversations WHERE id=? AND deleted_at IS NULL').get(id)),
    attachmentsForPaper(paperId: string) {
      return db.prepare(`SELECT m.payload FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id WHERE c.paper_id=?`)
        .all(paperId).flatMap(row => (JSON.parse(String(row.payload)) as ChatMessage).attachments);
    },
    list: (paperId: string) => db.prepare('SELECT * FROM chat_conversations WHERE paper_id=? AND deleted_at IS NULL ORDER BY updated_at DESC, rowid DESC').all(paperId).map(conversation),
    session: (id: string) => (db.prepare('SELECT session_id FROM chat_conversations WHERE id=?').get(id)?.session_id as string | null) ?? undefined,
    setSession: (id: string, session: string | null) => db.prepare('UPDATE chat_conversations SET session_id=? WHERE id=? AND deleted_at IS NULL').run(session, id),
    selectModel(id: string, providerId: AgentId, model: string, effort: string, resetSession = false) {
      const previous = get(id);
      db.prepare('UPDATE chat_conversations SET provider_id=?,model=?,effort=?,session_id=CASE WHEN provider_id=? AND ?=0 THEN session_id ELSE NULL END WHERE id=?')
        .run(providerId, model, effort, providerId, Number(resetSession), id);
      return get(previous.id);
    },
    title: (id: string, title: string) => db.prepare('UPDATE chat_conversations SET title=? WHERE id=?').run(title, id),
    delete(id: string) {
      get(id);
      db.prepare('UPDATE chat_conversations SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
    },
    restore(id: string) {
      if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM chat_conversations WHERE id=?').get(id)) throw new Error('对话不存在');
      db.prepare('UPDATE chat_conversations SET deleted_at=NULL WHERE id=?').run(id);
      return get(id);
    },
    recover() {
      for (const row of db.prepare('SELECT m.payload FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id WHERE c.deleted_at IS NULL').all()) {
        const message = JSON.parse(String(row.payload)) as ChatMessage;
        if (message.status === 'streaming') saveMessage({ ...message, status: 'interrupted', error: '应用退出时回答中断，可重新发送问题。' });
      }
    },
    fork(id: string, beforeMessageId: string) {
      const previous = get(id), history = messages(id);
      const index = history.findIndex(message => message.id === beforeMessageId);
      if (index < 0) throw new Error('分支起点不存在');
      const next = create(previous.paperId, previous.providerId, previous.model, `${previous.title.replace(/(?: · 分支)+$/, '')} · 分支`, previous.effort, previous.contextMode);
      const ids = new Map(history.slice(0, index).map(message => [message.id, randomUUID()]));
      db.exec('BEGIN');
      try {
        for (const message of history.slice(0, index)) saveMessage({ ...message, id: ids.get(message.id)!, conversationId: next.id,
          originIds: [...new Set([message.id, ...(message.originIds ?? [])])],
          messageReferences: message.messageReferences.map(reference => ({ ...reference, messageId: ids.get(reference.messageId) ?? reference.messageId })) });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return next;
    },
  };
}
