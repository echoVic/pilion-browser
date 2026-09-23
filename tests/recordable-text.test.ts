import { readFileSync } from 'node:fs';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it } from 'vitest';
import type { AgentPointer } from '../src/main/browser/agent-pointer';
import { ElectronPagePort } from '../src/main/browser/electron-page-adapter';
import { recordableText, type AxTextNode } from '../src/main/browser/recordable-text';

/**
 * 一个可访问性节点只写这条规则看得到的几项。各种字段在树上长什么样，照的是在 Electron 44
 * 的 Chromium 里对真实页面打完字之后 `Accessibility.getFullAXTree` 报出来的结构。
 */
type Shape = {
  role: string;
  name?: string;
  editable?: 'plaintext' | 'richtext';
  /** 名字取自 aria-labelledby 指向的元素时，节点带一个 labelledby 属性。 */
  labelledby?: boolean;
  ignored?: boolean;
  children?: Shape[];
};

/** 摊平成 getFullAXTree 回来的节点数组：父子两边都连上（parentId 与 childIds），先序排列。 */
function flatten(root: Shape): AxTextNode[] {
  const nodes: AxTextNode[] = [];
  let next = 0;
  const visit = (shape: Shape, parentId?: string): string => {
    next += 1;
    const node: AxTextNode = {
      nodeId: String(next),
      ...(parentId ? { parentId } : {}),
      ...(shape.ignored ? { ignored: true } : {}),
      role: { value: shape.role },
      name: { value: shape.name ?? '' },
      properties: [
        ...(shape.editable ? [{ name: 'editable', value: { value: shape.editable } }] : []),
        ...(shape.labelledby ? [{ name: 'labelledby', value: { relatedNodes: [] } }] : []),
      ],
    };
    nodes.push(node);
    node.childIds = (shape.children ?? []).map((child) => visit(child, node.nodeId));
    return node.nodeId;
  };
  visit(root);
  return nodes;
}
const page = (...children: Shape[]) => flatten({ role: 'RootWebArea', name: '页', children });
const text = (name: string, editable?: Shape['editable']): Shape => ({
  role: 'StaticText',
  name,
  editable,
});
/** 输入框的内部节点：值就是它下面的一段 StaticText，两层都带 editable。 */
const inner = (value: string): Shape => ({
  role: 'generic',
  editable: 'plaintext',
  children: [text(value, 'plaintext')],
});
/** 原生输入框：框、内部节点、那段字三层都带 editable。 */
const field = (role: string, value: string): Shape => ({
  role,
  editable: 'plaintext',
  children: [inner(value)],
});
/** 被忽略的中间节点：树上有它，Agent 与摘录都不读它，但它照样是父子链上的一环。 */
const skipped = (...children: Shape[]): Shape => ({ role: 'none', ignored: true, children });
const labelled = (label: string, control: Shape): Shape => ({
  role: 'LabelText',
  children: [text(label), control],
});

describe('recordableText', () => {
  it('原生输入框里的值一律不要：验证码、密码的圆点、普通文字、多行文本、搜索、数字与可编辑组合框', () => {
    const nodes = page(
      { role: 'paragraph', children: [text('普通段落')] },
      labelled('验证码 ', field('textbox', '482913')),
      labelled('密码 ', field('textbox', '••••••••••••••')),
      labelled('邮箱 ', field('textbox', 'a@b.cn')),
      labelled('多行 ', field('textbox', '多行打字')),
      // 搜索框、数字框的内部节点外面还隔着一层被忽略的节点。
      labelled('搜索 ', {
        role: 'searchbox',
        editable: 'plaintext',
        children: [skipped(inner('搜索打字'))],
      }),
      labelled('数字 ', {
        role: 'spinbutton',
        editable: 'plaintext',
        children: [skipped(inner('12345'))],
      }),
      // 带 datalist 的输入框是可编辑的组合框：角色不在文本输入类里，只能靠 editable 认出来。
      labelled('列表 ', {
        role: 'combobox',
        editable: 'plaintext',
        children: [skipped(skipped(inner('组合打字')))],
      }),
    );
    expect(recordableText(nodes)).toBe(
      ['普通段落', '验证码 ', '密码 ', '邮箱 ', '多行 ', '搜索 ', '数字 ', '列表 '].join('\n'),
    );
  });

  it('只读、禁用的输入框：值那一段与内部节点都不带 editable，靠框本身认出来', () => {
    const inert = (value: string): Shape => ({
      role: 'textbox',
      editable: 'plaintext',
      children: [{ role: 'generic', children: [text(value)] }],
    });
    const nodes = page(labelled('只读 ', inert('只读值')), labelled('禁用 ', inert('禁用值')));
    expect(recordableText(nodes)).toBe('只读 \n禁用 ');
  });

  it('富文本编辑区连同里面不可编辑的提及标签都不要', () => {
    // 没有角色属性的编辑宿主在树上是 generic，只靠 CSS -webkit-user-modify 变成可编辑的区域、
    // 封闭影子根里的编辑区也是这个样子：可访问性树看得见页面脚本看不见的这两种。
    const nodes = page(
      {
        role: 'generic',
        editable: 'richtext',
        children: [
          { role: 'paragraph', editable: 'richtext', children: [text('编辑区打字', 'richtext')] },
        ],
      },
      // contenteditable="false" 的提及标签：那段字自己不带 editable，直接挂在编辑宿主下面。
      {
        role: 'generic',
        editable: 'richtext',
        children: [text('前文 ', 'richtext'), text('@提及标签'), text(' 后文', 'richtext')],
      },
      { role: 'paragraph', children: [text('结尾段落')] },
    );
    expect(recordableText(nodes)).toBe('结尾段落');
  });

  it('文档开着 designMode 时整页都可编辑，摘录是空的', () => {
    const nodes = flatten({
      role: 'RootWebArea',
      editable: 'richtext',
      children: [
        {
          role: 'heading',
          name: '设计模式标题',
          editable: 'richtext',
          children: [text('设计模式标题', 'richtext')],
        },
        { role: 'paragraph', editable: 'richtext', children: [text('设计模式正文', 'richtext')] },
      ],
    });
    expect(recordableText(nodes)).toBe('');
  });

  it('不带 editable 的文本输入类角色照样不要；只能选的组合框不是输入框，照留', () => {
    // 自己接管按键、把字画进 div 的编辑器，只给那个 div 一个 textbox 之类的角色。
    const nodes = page(
      { role: 'textbox', name: '自定义', children: [text('自定义文本框内容')] },
      { role: 'searchbox', name: '自定义搜索', children: [text('自定义搜索内容')] },
      { role: 'spinbutton', name: '自定义数字', children: [text('七')] },
      { role: 'combobox', name: '自定义组合', children: [text('组合框显示文字')] },
    );
    expect(recordableText(nodes)).toBe('组合框显示文字');
  });

  it('名字取到了输入框或编辑区里的字的标题整条不要，标题自己的字由它下面的 StaticText 留下', () => {
    const nodes = page(
      { role: 'heading', name: '标题一', children: [text('标题一')] },
      // 标题里嵌着输入框：标题的名字带上了框里的值。aria-owns 把别处的输入框挂到标题下也是这样。
      {
        role: 'heading',
        name: '带输入的标题 标题内打字',
        children: [text('带输入的标题 '), field('textbox', '标题内打字')],
      },
      // aria-labelledby 指向输入框：标题的名字就是框里的值，树上它下面却没有那个框。
      {
        role: 'heading',
        name: '命名打字',
        labelledby: true,
        children: [text('被输入命名的标题')],
      },
      // 编辑区里的标题自己就带 editable。
      {
        role: 'generic',
        editable: 'richtext',
        children: [
          {
            role: 'heading',
            name: '编辑区里的标题',
            editable: 'richtext',
            children: [text('编辑区里的标题', 'richtext')],
          },
        ],
      },
      // 编辑区里不可编辑的嵌入块（contenteditable="false"）里的标题：标题与它的字都不带 editable，
      // 下面也没有可编辑的节点，只能靠祖先认出来。
      {
        role: 'generic',
        editable: 'richtext',
        children: [
          { role: 'paragraph', editable: 'richtext', children: [text('正文', 'richtext')] },
          skipped({ role: 'heading', name: '嵌入块标题', children: [text('嵌入块标题')] }),
        ],
      },
    );
    expect(recordableText(nodes)).toBe(
      ['标题一', '标题一', '带输入的标题 ', '被输入命名的标题'].join('\n'),
    );
  });

  it('父子关系只给了 parentId 或只给了 childIds 都认得出', () => {
    const nodes = page(
      { role: 'generic', editable: 'richtext', children: [text('@提及标签')] },
      { role: 'paragraph', children: [text('结尾段落')] },
    );
    const without = (key: 'parentId' | 'childIds') =>
      nodes.map((node) => {
        const copy = { ...node };
        delete copy[key];
        return copy;
      });
    expect(recordableText(without('parentId'))).toBe('结尾段落');
    expect(recordableText(without('childIds'))).toBe('结尾段落');
  });

  it('父子关系绕成一个环也会走完，不卡住主进程；环上的字按可编辑算，不要', () => {
    // 往上找可编辑祖先、从输入框往上标记祖先，两条路都得在环上停下来。环外的字照留。
    const nodes: AxTextNode[] = [
      { nodeId: 'root', role: { value: 'RootWebArea' } },
      { nodeId: 'p', parentId: 'root', role: { value: 'paragraph' } },
      { nodeId: 'ok', parentId: 'p', role: { value: 'StaticText' }, name: { value: '环外的字' } },
      { nodeId: 'a', parentId: 'b', role: { value: 'generic' } },
      { nodeId: 'b', parentId: 'a', role: { value: 'generic' } },
      { nodeId: 'box', parentId: 'b', role: { value: 'textbox' } },
      { nodeId: 't', parentId: 'a', role: { value: 'StaticText' }, name: { value: '环里的字' } },
      { nodeId: 's', parentId: 's', role: { value: 'StaticText' }, name: { value: '自环的字' } },
    ];
    expect(recordableText(nodes)).toBe('环外的字');
  });

  it('每个节点只判一次可不可编辑：树再深，判定次数也只跟节点数同阶', () => {
    // 一千层深的一条链，底下挂一千段字：每段字各自往上走到根，就是一百万次判定。
    let checks = 0;
    const node = (nodeId: string, parentId: string | undefined, role: string, name = '') =>
      // 判一次可不可编辑就要读一次 properties。
      Object.defineProperty(
        { nodeId, ...(parentId ? { parentId } : {}), role: { value: role }, name: { value: name } },
        'properties',
        { get: () => ((checks += 1), []) },
      ) as AxTextNode;
    const nodes = [node('0', undefined, 'RootWebArea')];
    for (let depth = 1; depth <= 1000; depth += 1)
      nodes.push(node(String(depth), String(depth - 1), 'generic'));
    for (let index = 0; index < 1000; index += 1)
      nodes.push(node(`t${index}`, '1000', 'StaticText', `第 ${index} 段`));
    expect(recordableText(nodes).split('\n')).toHaveLength(1000);
    expect(checks).toBeLessThan(3 * nodes.length);
  });
});

/** 只够构造适配器与读正文的假 WebContents：记下发出去的每一条 CDP 命令。 */
function fakePort(nodes: AxTextNode[]) {
  const commands: string[] = [];
  const webContents = {
    debugger: {
      isAttached: () => true,
      sendCommand: (method: string) => {
        commands.push(method);
        return Promise.resolve({ nodes });
      },
    },
    on: () => webContents,
    setWindowOpenHandler: () => undefined,
  };
  const port = new ElectronPagePort(
    { webContents } as unknown as WebContentsView,
    {} as BrowserWindow,
    (url) => Promise.resolve(url),
    {} as AgentPointer,
  );
  return { port, commands };
}

describe('ElectronPagePort 读正文', () => {
  it('Agent 用的 readText 与改动前逐字相同，录制用的 readRecordableText 只靠同一棵树判断', async () => {
    const { port, commands } = fakePort(
      page(
        { role: 'heading', name: '登录', children: [text('登录')] },
        labelled('验证码 ', field('textbox', '482913')),
        labelled('密码 ', field('textbox', '••••••••••••••')),
        { role: 'generic', editable: 'richtext', children: [text('编辑区打字', 'richtext')] },
        { role: 'paragraph', children: [text('普通段落')] },
      ),
    );
    // Agent 读页面不在这次改动的范围里：这一串就是改动之前的 readText 在这棵树上的输出。
    expect(await port.readText()).toBe(
      '登录\n登录\n验证码 \n482913\n密码 \n••••••••••••••\n编辑区打字\n普通段落',
    );
    expect(await port.readRecordableText()).toBe('登录\n登录\n验证码 \n密码 \n普通段落');
    // 录制那份不另查 DOM：跟 readText 一样只发这一条命令。
    expect(commands).toEqual(['Accessibility.getFullAXTree', 'Accessibility.getFullAXTree']);
  });

  it('树上没有可编辑的内容时两份逐字相同，都照 getFullAXTree 给的节点顺序', async () => {
    // Chromium 给的节点顺序不是文档顺序（比如输入框里的字排在最后），录制那份也不重排。
    const nodes = page(
      { role: 'heading', name: '月度报表', children: [text('月度报表')] },
      { role: 'paragraph', children: [text('本月导出 42 笔')] },
      { role: 'paragraph', children: [{ role: 'StaticText', name: '藏起来的字', ignored: true }] },
      { role: 'link', name: '下载', children: [text('下载')] },
    ).reverse();
    const { port } = fakePort(nodes);
    const agent = await port.readText();
    expect(agent).toBe('下载\n本月导出 42 笔\n月度报表\n月度报表');
    expect(await port.readRecordableText()).toBe(agent);
  });

  it('Agent 的 browser.snapshot 与 browser.page_info 仍然读 readText', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const tool = main.slice(
      main.indexOf("case 'browser.snapshot':"),
      main.indexOf("case 'browser.screenshot':"),
    );
    expect(tool).toContain('await page.readText?.()');
    expect(tool).not.toContain('readRecordableText');
  });
});
