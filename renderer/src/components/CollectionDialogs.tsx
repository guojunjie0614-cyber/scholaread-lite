import { useState } from 'react';
import type { Collection } from '@shared/types';
import { Modal } from './Modal';
import DesktopMenu from './DesktopMenu';
import { IconChevronDown } from './icons';
import { collectionLabel, collectionOptions, collectionDescendants } from '@/lib/library';

export function CollectionPicker({
  collections,
  selected,
  onChange,
}: {
  collections: Collection[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="collection-picker">
      {collections.length ? (
        collectionOptions(collections).map((c) => (
          <label key={c.id} className={c.parentId ? 'nested' : ''}>
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
              }
            />
            <span>{collectionLabel(c.id, collections)}</span>
          </label>
        ))
      ) : (
        <p className="hint">还没有分类，请先在左侧「我的分类」旁新建。</p>
      )}
    </div>
  );
}

export function CollectionEditor({
  collections,
  target,
  onSave,
  onDelete,
  onClose,
}: {
  collections: Collection[];
  target: { collection?: Collection; parentId?: string | null };
  onSave: (name: string, parentId: string | null) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.collection?.name ?? '');
  const [parentId, setParentId] = useState(target.collection?.parentId ?? target.parentId ?? '');
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    if (busy || (!deleting && !name.trim())) return;
    setBusy(true);
    setError('');
    try {
      if (deleting) await onDelete?.();
      else await onSave(name, parentId || null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={deleting ? '删除分类？' : target.collection ? '编辑分类' : '新建分类'}
      className="collection-dialog"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {onDelete && !deleting && (
            <button
              className="btn danger collection-delete"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              删除分类…
            </button>
          )}
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className={`btn ${deleting ? 'danger' : 'primary'}`}
            disabled={busy || (!deleting && !name.trim())}
            onClick={() => void run()}
          >
            {busy ? '保存中…' : deleting ? '删除分类' : target.collection ? '保存' : '创建'}
          </button>
        </>
      }
    >
      {deleting ? (
        <>
          <p>删除「{target.collection?.name}」及其子分类？</p>
          <p className="hint">文献、PDF 和笔记都会保留，可以在「全部文献」中找到。</p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="field">
            <label htmlFor="collection-name">名称</label>
            <input
              id="collection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="field">
            <label>位置</label>
            <DesktopMenu
              ariaLabel="位置"
              className="field-menu"
              disabled={busy}
              width={372}
              items={[
                { id: '', label: '文献库', selected: !parentId, onSelect: () => setParentId('') },
                ...collectionOptions(collections).filter(c => !target.collection || !collectionDescendants(target.collection.id, collections).has(c.id)).map((c) => ({
                  id: c.id, label: collectionLabel(c.id, collections), selected: parentId === c.id, onSelect: () => setParentId(c.id),
                })),
              ]}
            >
              <span>{parentId ? collectionLabel(parentId, collections) : '文献库'}</span>
              <IconChevronDown />
            </DesktopMenu>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function OrganizeDialog({
  collections,
  title,
  initial = [],
  allowEmpty = false,
  onSave,
  onClose,
}: {
  collections: Collection[];
  title: string;
  initial?: string[];
  allowEmpty?: boolean;
  onSave: (ids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(selected);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      className="collection-dialog"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || (!allowEmpty && !selected.length)}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <CollectionPicker collections={collections} selected={selected} onChange={setSelected} />
      {allowEmpty && <p className="hint">取消全部分类后，文献会显示在「未分类」中。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
