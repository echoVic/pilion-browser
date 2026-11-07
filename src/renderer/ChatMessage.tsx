import { createContext, useContext, isValidElement, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  MessagePrimitive,
  ActionBarPrimitive,
  useAuiState,
  type TextMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, Copy, CircleAlert, LoaderCircle, MessageSquare } from 'lucide-react';
import { Checkbox, IconButton } from './ui';
import { formatClock, localFileHref, safeExternalHref } from './panel/links';

/** pre 渲染器把内部 code 标记为块级上下文，块级 code 不应用 inline-code 底色/描边。 */
const BlockCodeContext = createContext(false);

function extractLanguage(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const className = (node.props as { className?: string }).className;
  return /language-([\w-]+)/.exec(className ?? '')?.[1];
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = extractLanguage(children);
  const code = isValidElement(children)
    ? (children.props as { children?: ReactNode }).children
    : undefined;
  const text = Array.isArray(code) ? code.join('') : String(code ?? '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <BlockCodeContext.Provider value={true}>
      <div className="code-block">
        <div className="code-block-header">
          <span className="code-lang">{language ?? 'code'}</span>
          <button
            className={clsx('code-copy', { copied })}
            onClick={copy}
            type="button"
            aria-label={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre>{children}</pre>
      </div>
    </BlockCodeContext.Provider>
  );
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const inBlock = useContext(BlockCodeContext);
  return (
    <code className={inBlock ? className : clsx('inline-code', className)}>
      {children as React.ReactNode}
    </code>
  );
}

/**
 * 消息里的本地文件链接：交给主进程解析并打开（文档）或定位（其它类型）。
 * 打不开时把原因贴在旁边，而不是让按钮静默无反应。
 */
function LocalFileLink({ href, children }: { href: string; children: ReactNode }) {
  const [state, setState] = useState<'idle' | 'opening' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const open = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!event.nativeEvent.isTrusted) return;
    setState('opening');
    try {
      const state = await window.pilion.getState();
      await window.pilion.files.open(href, state.activeConversationId);
      setState('idle');
    } catch (cause) {
      // Electron 会给 IPC 错误加一层 "Error invoking remote method 'files:open':" 前缀。
      const raw = cause instanceof Error ? cause.message : String(cause);
      setMessage(raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
      setState('error');
    }
  };
  return (
    <span className="md-file">
      <button
        type="button"
        className={clsx('md-link', state !== 'idle' && `is-${state}`)}
        title={state === 'error' ? `${href}\n${message}` : `打开 ${href}`}
        aria-busy={state === 'opening' || undefined}
        onClick={(event) => void open(event)}
      >
        {children}
      </button>
      {state === 'error' && (
        <span className="md-file-error" role="status">
          {message || '打不开这个文件'}
        </span>
      )}
    </span>
  );
}

function MarkdownPart({ text }: TextMessagePartProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safe = safeExternalHref(href);
          if (safe)
            return (
              <button
                className="md-link"
                title={safe}
                onClick={() => void window.pilion.tabs.open(safe).catch(() => undefined)}
              >
                {children}
              </button>
            );
          const local = localFileHref(href);
          if (local) return <LocalFileLink href={local}>{children}</LocalFileLink>;
          // 既不是网页也不是可打开的本地文件：保持文字，不再伪装成可点的链接。
          return <span className="md-plain">{children}</span>;
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => (
          <div className="md-table-wrap">
            <table className="md-table">{children}</table>
          </div>
        ),
        input: (props) =>
          props.type === 'checkbox' ? (
            <Checkbox checked={props.checked} disabled={props.disabled} />
          ) : (
            <input {...props} />
          ),
        // 任务列表项的 task-list-item 类名由 remark-gfm 经 hast properties 透传，无需自定义渲染器
        code: Code,
      }}
    >
      {text}
    </Markdown>
  );
}

function ReasoningPart({ text }: ReasoningMessagePartProps) {
  return (
    <details className="thought">
      <summary>
        思考过程
        <ChevronDown size={12} />
      </summary>
      <div>{text}</div>
    </details>
  );
}

function ToolPart({ toolName, result, isError }: ToolCallMessagePartProps) {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  return (
    <div
      className={clsx('tool-message', { failed: isError, completed: !isError && result })}
      title={`工具调用：${toolName}`}
      role={running ? 'status' : undefined}
    >
      {running ? (
        <LoaderCircle size={14} className="ic-spin" />
      ) : isError ? (
        <CircleAlert size={14} className="ic-fail" />
      ) : (
        <Check size={14} className="ic-done" />
      )}
      <span className="tool-name">{toolName}</span>
    </div>
  );
}

const parts = {
  Text: MarkdownPart,
  Reasoning: ReasoningPart,
  tools: { Fallback: ToolPart },
  Empty: () => null,
};

export function ChatMessage() {
  const message = useAuiState((s) => s.message);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const kind = message.metadata.custom.kind ?? message.role;
  if (message.content.length === 0) return null;
  const time = formatClock(String(message.createdAt));

  if (kind === 'system')
    return (
      <MessagePrimitive.Root className="sys-msg" role="alert">
        <CircleAlert size={14} />
        <div>
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.Root>
    );

  if (kind === 'user')
    return (
      <MessagePrimitive.Root className="msg msg-user">
        <div className="msg-body">
          <div className="bubble">
            <MessagePrimitive.Parts components={parts} />
          </div>
        </div>
        {time && <span className="bubble-time">{time}</span>}
      </MessagePrimitive.Root>
    );

  if (kind === 'thought' || kind === 'tool')
    return (
      <MessagePrimitive.Root
        className={clsx('msg', kind === 'thought' ? 'msg-reasoning' : 'msg-tool')}
      >
        <div className="msg-body">
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.Root>
    );

  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <div className="author-row">
        <span className="agent-avatar">
          <MessageSquare size={12} />
        </span>
        Agent
        {time && <time>{time}</time>}
      </div>
      <div className="msg-body">
        <MessagePrimitive.Parts components={parts} />
      </div>
      {message.status?.type !== 'running' && (
        <ActionBarPrimitive.Root className="msg-footer" hideWhenRunning>
          <IconButton
            label={copied ? '已复制' : copyError ? '复制失败，重试' : '复制回复'}
            className={clsx({ copied })}
            onClick={async () => {
              try {
                await window.pilion.workspace.copyMessage(message.id);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </IconButton>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
