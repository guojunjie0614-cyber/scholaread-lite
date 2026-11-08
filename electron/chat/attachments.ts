import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { ChatAttachment } from '../../shared/chat-types.js';
import type { AgentImage } from './provider-types.js';

export function decodeImage(dataUrl: string): { mime: string; bytes: Buffer } {
  if (typeof dataUrl !== 'string' || dataUrl.length > 14 * 1024 * 1024) throw new Error('每张图片不能超过 10 MB');
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('请发送 PNG、JPEG、GIF 或 WebP 图片');
  const bytes = Buffer.from(match[2], 'base64'), mime = match[1];
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('图片为空或超过 10 MB');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/gif' ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw new Error('图片内容与格式不符');
  return { mime, bytes };
}

export function createAttachments(root: string) {
  const dir = path.join(root, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = ({ id, mime }: Pick<ChatAttachment, 'id' | 'mime'>) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('图片附件 ID 无效');
    const extension: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
    if (!extension[mime]) throw new Error('图片附件格式无效');
    return path.join(dir, `${id}${extension[mime]}`);
  };
  return {
    saveMany(inputs: ChatAttachment[], reusable: ChatAttachment[]): ChatAttachment[] {
      // Reuse only IDs resolved from persisted messages of this paper, including edit branches.
      const existing = new Map(reusable.map(attachment => [attachment.id, attachment]));
      const prepared = inputs.map(input => {
        if (!input || typeof input.name !== 'string' || input.name.length > 500) throw new Error('图片附件无效');
        const previous = existing.get(input.id);
        if (previous) {
          if (!fs.existsSync(fileFor(previous))) throw new Error(`图片附件已不存在：${previous.name}`);
          return { attachment: previous, bytes: undefined };
        }
        const { mime, bytes } = decodeImage(input.dataUrl);
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('无法解码这张图片');
        const id = randomUUID(), size = image.getSize();
        const scale = Math.min(1, 480 / size.width, 480 / size.height);
        const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }) : image;
        return { attachment: { id, name: input.name, mime, dataUrl: preview.toDataURL() }, bytes };
      });
      const written: string[] = [];
      try {
        for (const item of prepared) if (item.bytes) {
          const file = fileFor(item.attachment);
          fs.writeFileSync(file, item.bytes, { mode: 0o600 }); written.push(file);
        }
      } catch (error) { for (const file of written) fs.rmSync(file, { force: true }); throw error; }
      return prepared.map(item => item.attachment);
    },
    read(input: ChatAttachment): AgentImage {
      const file = fileFor(input);
      if (!fs.existsSync(file)) throw new Error(`图片附件已不存在：${input.name}`);
      const bytes = fs.readFileSync(file);
      return { path: file, mime: input.mime, base64: bytes.toString('base64') };
    },
  };
}
