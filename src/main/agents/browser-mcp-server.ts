import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ElementRefSchema,
  MAX_UPLOAD_FILES,
  PointerActionSchema,
  PressKeySchema,
  PressModifierSchema,
  type ToolName,
} from '../../shared/contracts.js';

export function createBrowserMcpServer(
  execute: (name: ToolName, args: Record<string, unknown>) => Promise<unknown>,
  options: { tools?: readonly ToolName[] } = {},
): McpServer {
  const server = new McpServer({ name: 'pilion-browser', version: '0.2.1' });
  const allowed = new Set(options.tools);
  const tab = { tabId: z.string().min(1).max(256).optional() };
  const target = { ...tab, elementRef: ElementRefSchema };
  function register(name: ToolName, description: string, inputSchema: z.ZodRawShape) {
    if (allowed.size && !allowed.has(name)) return;
    server.registerTool(name.replaceAll('.', '_'), { description, inputSchema }, async (input) => {
      try {
        const result = await execute(name, input as Record<string, unknown>);
        if (
          result &&
          typeof result === 'object' &&
          typeof (result as { data?: unknown }).data === 'string'
        ) {
          const mimeType = (result as { mimeType?: unknown }).mimeType;
          if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
            // 图片之外的字段（降级诊断、瞄准用的尺寸）单独放一段文字，图片块本身不变。
            const details = Object.fromEntries(
              Object.entries(result).filter(([key]) => key !== 'data' && key !== 'mimeType'),
            );
            return {
              content: [
                { type: 'image', data: (result as { data: string }).data, mimeType },
                ...(Object.keys(details).length
                  ? [{ type: 'text' as const, text: JSON.stringify(details) }]
                  : []),
              ],
            };
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });
  }
  register(
    'browser.snapshot',
    'Read the current page snapshot: URL, title, loading state and visible text. Use before deciding what to click or type.',
    tab,
  );
  register(
    'browser.screenshot',
    'Capture a screenshot of the current browser page for visual layout and state. Oversized pages are auto-downgraded (jpeg, then a smaller scale) to fit the response. Optional: scale (0.1..1), quality (1..100, jpeg), format (png|jpeg), clip {x,y,width,height} in page CSS pixels (a surface row box from browser_observe can be passed as is). A text block after the image gives width/height (image pixels) and cssWidth/cssHeight (page area covered): CSS pixel = image pixel × cssWidth / width. A clip wholly outside the visible page is refused with the browser_scroll amount to use (it would be blank); partial:true in the text block means part of the clip was off-screen and is blank in the image.',
    {
      ...tab,
      scale: z.number().min(0.1).max(1).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      format: z.enum(['png', 'jpeg']).optional(),
      clip: z
        .object({
          x: z.number().finite().min(0).max(100_000),
          y: z.number().finite().min(0).max(100_000),
          width: z.number().finite().min(1).max(100_000),
          height: z.number().finite().min(1).max(100_000),
        })
        .strict()
        .optional(),
    },
  );
  register('browser.tabs.list', 'List tabs shared with this agent.', {});
  register('browser.tabs.open', 'Open a browser tab.', {
    url: z.string().max(8192).optional(),
  });
  register('browser.tabs.activate', 'Activate a tab.', {
    tabId: z.string().min(1).max(256),
  });
  register('browser.tabs.close', 'Close a tab.', {
    tabId: z.string().min(1).max(256),
  });
  register('browser.navigate', 'Navigate to a URL.', {
    ...tab,
    url: z.string().min(1).max(8192),
  });
  register('browser.page_info', 'Read page title, URL and loading state without the body.', tab);
  register(
    'browser.request_human',
    'Hand the browser back to the person when you cannot continue alone, for example a sign-in, a captcha or a payment step. Say why in one sentence, then end your turn; they will resume you.',
    { reason: z.string().min(1).max(500) },
  );
  register(
    'browser.observe',
    'Observe up to 200 DOM candidates. Use offset 200, 400, etc. for later pages. Always use fresh element references for interactions.',
    { ...tab, offset: z.number().int().min(0).max(100_000).optional() },
  );
  register(
    'browser.click',
    'Click a fresh observed link or button. Do not invent elementRef values. Set force:true when a native control is covered or has no layout: it activates the control with a synthetic click instead of a pointer hit.',
    { ...target, force: z.boolean().optional() },
  );
  register(
    'browser.hover',
    'Hover a fresh observed element (or its hoverable ancestor) and let the pointer settle, so hover-only edit/delete controls gain layout before you click them.',
    target,
  );
  register(
    'browser.pointer',
    'Pointer input at a position on a <canvas> or <video> surface only: browser_observe rows with surface:true and a box. Coordinates are CSS pixels relative to the top-left of that surface content box, never raw viewport coordinates. action is {type:"click",x,y,button?:"left"|"right"|"middle",count?:1|2|3} | {type:"move",x,y} | {type:"drag",from:{x,y},to:{x,y}} (left button) | {type:"wheel",x,y,deltaX?,deltaY?}. Aim with browser_screenshot using the row box as clip, convert image pixels to CSS pixels, act, then screenshot again to verify. If a point is off-screen, Pilion first tries to scroll the surface into view; this can change the viewport even if the action is later refused. Refused before any pointer input when a point is outside the box, remains off-screen after that attempt, another element covers it, or the target is not a canvas/video (use browser_click/browser_hover with a ref instead). After scrolling, observe again before the next action; if a point remains off-screen, scroll until it is visible and re-observe before retrying. Keys still go through browser_press. The result {ok, effect:"dispatched"} never proves the page reacted.',
    { ...target, action: PointerActionSchema },
  );
  register(
    'browser.type',
    'Type into a fresh observed input or textarea. Do not invent elementRef values.',
    {
      ...target,
      text: z.string().max(100_000),
      replace: z.boolean().optional(),
    },
  );
  register('browser.select', 'Select an option.', {
    ...target,
    value: z.string().min(1).max(10_000),
  });
  register('browser.check', 'Set a checkbox or radio.', {
    ...target,
    checked: z.boolean(),
  });
  register(
    'browser.press',
    'Press a supported key. Omit elementRef to send the key to the current focused element. The result carries effect: activated (page state changed), none (dispatched with no change) or dispatched (state could not be measured).',
    {
      ...tab,
      elementRef: ElementRefSchema.optional(),
      key: PressKeySchema,
      modifiers: z.array(PressModifierSchema).max(1).optional(),
    },
  );
  register(
    'browser.scroll',
    'Scroll the page viewport by mouse wheel. Omit amount to scroll about 80% of the viewport height. This is not a page effect: it does not change page state and is not gated by approval. After scrolling, observe again before clicking elements that were off-screen.',
    {
      ...tab,
      direction: z.enum(['up', 'down']),
      amount: z.number().int().min(1).max(10_000).optional(),
    },
  );
  register(
    'browser.upload_file',
    `Write local files into an <input type=file> target returned by browser_observe. Works even when the input is visually hidden. files must be absolute paths to existing regular files (symlinks rejected, 200MB each, at most ${MAX_UPLOAD_FILES}). The action is recorded with each path and size.`,
    { ...target, files: z.array(z.string().min(1).max(4096)).min(1).max(MAX_UPLOAD_FILES) },
  );
  register(
    'browser.skills.list',
    'List the skills the person recorded and kept in this workspace. Prefer a matching skill over exploring by hand; each entry says when to use it. Returns [{ id, name, about, steps, needsHuman, recordedAt }].',
    {},
  );
  register(
    'browser.skills.play',
    'Replay a kept skill on the current tab. Returns { ok: true, steps, finalUrl } when every step ran. On { ok: false } read failedAt, step, url and remaining: fix only that step with browser_observe and the effect tools, then call this again with fromStep = failedAt + 1. On reason "HUMAN" the browser was handed to the person: end your turn, and when they resume you continue with fromStep. The first replay of a skill in a task asks the person once.',
    {
      skillId: z.string().min(1).max(60),
      fromStep: z.number().int().min(1).max(500).optional(),
    },
  );
  register(
    'browser.schedule.create',
    'Create a scheduled prompt that runs later in a background conversation. Always asks the person for approval. The prompt may reference a recorded skill, e.g. "use browser.skills.play to run skill X". Cannot be called from a conversation that was itself started by a scheduled task. rule is one of {kind:"interval",every,unit} (minimum 10 minutes), {kind:"daily",time:"HH:MM"}, {kind:"weekdays",days:[0-6],time:"HH:MM"}, or {kind:"cron",expr:"min hour dom month dow"} (5 fields, no seconds/year/@reboot).',
    {
      name: z.string().min(1).max(120),
      agentId: z.string().min(1).max(256),
      prompt: z.string().min(1).max(100_000),
      rule: z.unknown(),
    },
  );
  register(
    'browser.schedule.list',
    'List scheduled prompts with their id, name, rule, enabled state and next run time.',
    {},
  );
  register(
    'browser.schedule.delete',
    'Delete a scheduled prompt by id. Asks the person for approval.',
    {
      id: z.string().min(1).max(256),
    },
  );
  return server;
}
