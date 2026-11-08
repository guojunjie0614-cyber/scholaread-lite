import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentConfig, AgentId, AgentInfo } from '../../shared/chat-types.js';

const labels: Record<AgentId, string> = { codex: 'Codex', claude: 'Claude Code', agy: 'Antigravity' };
export function isAgentId(value: unknown): value is AgentId { return value === 'codex' || value === 'claude' || value === 'agy'; }

export function createProviderSettings(root: string) {
  const file = path.join(root, 'agents.json');
  let configurations: Partial<Record<AgentId, AgentConfig>> = {};
  if (fs.existsSync(file)) configurations = JSON.parse(fs.readFileSync(file, 'utf8'));
  const executable = (candidate: string): boolean => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
  };
  const detect = (id: AgentId, configured?: string): string | null => {
    if (configured) return executable(configured) ? configured : null;
    const dirs = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(path.delimiter)];
    return dirs.map(dir => path.resolve(dir, id)).find(executable) ?? null;
  };
  const list = (): AgentInfo[] => (Object.keys(labels) as AgentId[]).map(id => {
    const config = configurations[id] ?? {}, executablePath = detect(id, config.executablePath);
    const unavailableReason = id === 'agy'
      ? 'Antigravity 接入暂缓：当前 CLI 的工具限制尚未通过验证，请选择 Codex 或 Claude Code。' : undefined;
    return { id, label: labels[id], available: executablePath !== null && !unavailableReason, executablePath, config, images: true, unavailableReason,
      detail: id === 'agy' ? '图片通过 agy 的受控 view_file 工具读取，确认读取成功后显示回答。' : '使用本机 Agent 的登录与模型配置。' };
  });
  return {
    list,
    get(id: AgentId) { return list().find(provider => provider.id === id)!; },
    configure(id: AgentId, value: AgentConfig) {
      if (!isAgentId(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 设置无效');
      const config: AgentConfig = {};
      for (const key of ['executablePath', 'model', 'effort'] as const) {
        const text = value[key];
        if (text !== undefined && (typeof text !== 'string' || text.length > 1000 || /[\x00\r\n]/.test(text))) throw new Error('Agent 设置字段无效');
        if (text?.trim()) config[key] = text.trim();
      }
      if (config.executablePath && (!path.isAbsolute(config.executablePath) || !executable(config.executablePath))) throw new Error('请选择可执行的 Agent 绝对路径');
      configurations[id] = config;
      fs.mkdirSync(root, { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(configurations, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
      return list();
    },
  };
}
