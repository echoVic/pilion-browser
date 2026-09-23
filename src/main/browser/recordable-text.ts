/** `Accessibility.getFullAXTree` 回来的节点里，录制摘录用得到的那几项；字段名照 CDP 的 AXNode。 */
export interface AxTextNode {
  nodeId: string;
  parentId?: string;
  childIds?: ReadonlyArray<string>;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: ReadonlyArray<{ name?: string; value?: unknown }>;
}

/**
 * 不看 editable 也当作输入框的角色：自己接管按键、把字画进普通元素的编辑器，只给那个元素一个
 * 这样的角色，树上不带 editable。组合框不在其中：只能选的那种显示的是选中项，能打字的那种带 editable。
 */
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);

/**
 * 拿人打的字去比页面上别的行时，值至少这么长：一个字的值（数量框里的「1」）会撞上一大片普通的行。
 * 值只是含在一行里面（而不是整行就是它）时要更长，免得短值在长句里碰巧撞上。
 */
const SHORTEST_VALUE = 2;
const SHORTEST_CONTAINED = 4;

/** 比对用的形状：空白折成一个空格、去掉首尾空白、不分大小写。 */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 按开头 size 个字给值分组：逐位查表，一行字只扫一遍，不必拿每个值各自把整页找一遍。 */
function byHead(values: ReadonlySet<string>, size: number): Map<string, string[]> {
  const heads = new Map<string, string[]>();
  for (const value of values) {
    if (value.length < size) continue;
    const head = value.slice(0, size);
    const group = heads.get(head);
    if (group) group.push(value);
    else heads.set(head, [value]);
  }
  return heads;
}

/** text 里每一处出现的值，按起点与长度回调。 */
function eachMatch(
  text: string,
  heads: Map<string, string[]>,
  size: number,
  found: (at: number, length: number) => void,
): void {
  if (!heads.size) return;
  for (let at = 0; at + size <= text.length; at += 1)
    for (const value of heads.get(text.slice(at, at + size)) ?? [])
      if (text.startsWith(value, at)) found(at, value.length);
}

/**
 * 去掉页面自己把人打的字另写成普通文字的那几行：整行等于某个值、含有某个够长的值，或者连着几行都
 * 只有一个字、拼起来是某个值。values 已经 fold 过，都够 SHORTEST_VALUE。摘录只要前 limit 个字，
 * 凑够就停，大页面上不必把每一行都比一遍；结果与全比完再截断逐字相同。
 */
function withoutEchoes(
  lines: ReadonlyArray<string>,
  values: ReadonlySet<string>,
  limit: number,
): string[] {
  const contained = byHead(values, SHORTEST_CONTAINED);
  const spelled = byHead(values, SHORTEST_VALUE);
  const out: string[] = [];
  // 已经留下的字数，连每行后面的换行一起算：超过 limit 时，拼起来至少有 limit 个字。
  let length = 0;
  for (let start = 0; start < lines.length && length <= limit;) {
    // 不止一个字的行自己成一组；只有一个字的，连着的单字行收成一组，拼起来找值。
    const group = [fold(lines[start])];
    while (group[0].length === 1 && start + group.length < lines.length) {
      const next = fold(lines[start + group.length]);
      if (next.length !== 1) break;
      group.push(next);
    }
    const drop = group.map((line) => values.has(line));
    if (group.length > 1)
      // 拼出值的那几行不要，同一串里别的单字行照留。
      eachMatch(group.join(''), spelled, SHORTEST_VALUE, (at, size) =>
        drop.fill(true, at, at + size),
      );
    else eachMatch(group[0], contained, SHORTEST_CONTAINED, () => (drop[0] = true));
    group.forEach((_, index) => {
      if (drop[index]) return;
      out.push(lines[start + index]);
      length += lines[start + index].length + 1;
    });
    start += group.length;
  }
  return out;
}

/**
 * 录制摘录用的页面正文。取的节点与顺序都和 Agent 读页面的 readText 一样（没被忽略的 StaticText
 * 与标题），只是人能往里打字的地方一律跳过：输入框、文本域、数字框、可编辑的组合框和富文本编辑区，
 * 不管是不是密码。
 *
 * 浏览器把输入框的值作为 StaticText 挂在框下面（密码是一串圆点，个数就是长度），编辑区里的字也是
 * StaticText，所以一段字只要自己或某个祖先带 editable 属性、或是文本输入类角色，就不要。只读、
 * 禁用的输入框和编辑区里不可编辑的提及标签，那段字自己不带 editable，要靠祖先认出来。标题的名字
 * 从内容算，会把嵌在里面的输入框的值算进去，也会取 aria-labelledby 指向的输入框的值，所以子树里有
 * 这类节点、或名字取自 aria-labelledby 的标题整条不要；标题自己的字仍由它下面的 StaticText 留下。
 * 树坏成父子绕圈的样子时，环上的字也不要。
 *
 * 页面自己把人打的字另写成普通文字时，树上看不出那是人打的：input-otp（shadcn/ui 的 InputOTP、
 * HeroUI 的 InputOtp 都用它）把验证码每一位画进一个方框、上面盖着一个透明的验证码框，编辑框旁边有
 * 实时预览，搜索结果页写着「……的搜索结果」。但框里的值就挂在框下面，是上面跳过的那些 StaticText，
 * 所以拿它们去比留下的行（标题那一行也比）：整行等于某个值（至少两个字）、含有某个至少四个字的值，
 * 或者连着几行都只有一个字、拼起来是某个值（那几行），也不要。
 */
export function recordableText(nodes: ReadonlyArray<AxTextNode>): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  // Chromium 两边都给；只给了一边也照样认得出父子。
  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    for (const child of node.childIds ?? []) parentOf.set(child, node.nodeId);
    if (node.parentId !== undefined) parentOf.set(node.nodeId, node.parentId);
  }
  // 下面两圈往上走的步数上限：不绕圈的一条父链，除了最后一个，每个节点在 parentOf 里都有一项，
  // 所以最多 parentOf.size + 1 个节点，树完好时就是节点数。走超了只可能是防环的那一步坏了：
  // 当场报错（录制那边摘录就空着），不在主进程里空转，测试也当场变红而不是卡死。
  const climb = (steps: number) => {
    if (steps > parentOf.size + 1) throw new Error('可访问性树的父子关系走不到头');
  };
  const has = (node: AxTextNode, property: string) =>
    (node.properties ?? []).some((item) => item.name === property);
  const editable = (node: AxTextNode) =>
    has(node, 'editable') || TEXT_INPUT_ROLES.has(node.role?.value ?? '');
  // 自己或某个祖先可编辑。每个节点的结论随走随记，后面的字走到记过的节点就停，整棵树只判一遍。
  const verdict = new Map<string, boolean>();
  const inEditable = (node: AxTextNode) => {
    const path: string[] = [];
    let result = false;
    for (let id: string | undefined = node.nodeId; id !== undefined; id = parentOf.get(id)) {
      const known = verdict.get(id);
      if (known !== undefined) {
        result = known;
        break;
      }
      // 先记成可编辑再往上：树坏成一个环时，绕回来就停在这一条上，环上的字宁可不要。
      verdict.set(id, true);
      path.push(id);
      climb(path.length);
      const current = byId.get(id);
      if (current && editable(current)) {
        result = true;
        break;
      }
    }
    for (const id of path) verdict.set(id, result);
    return result;
  };
  // 子树里有可编辑节点的那些节点：从每个可编辑节点往上标，碰到标过的就停。
  const holdsEditable = new Set<string>();
  for (const node of nodes) {
    if (!editable(node)) continue;
    let steps = 0;
    for (let id = parentOf.get(node.nodeId); id !== undefined; id = parentOf.get(id)) {
      if (holdsEditable.has(id)) break;
      holdsEditable.add(id);
      climb((steps += 1));
    }
  }
  const readable = nodes.filter(
    (node) => !node.ignored && ['StaticText', 'heading'].includes(node.role?.value ?? ''),
  );
  // 人打的字：框里的值与编辑区里的字，就是跳过的那些 StaticText。
  const values = new Set(
    readable
      .filter((node) => node.role?.value === 'StaticText' && inEditable(node))
      .map((node) => fold(node.name?.value ?? ''))
      .filter((value) => value.length >= SHORTEST_VALUE),
  );
  const kept = readable
    .filter((node) => !inEditable(node))
    .filter(
      (node) =>
        node.role?.value !== 'heading' ||
        (!holdsEditable.has(node.nodeId) && !has(node, 'labelledby')),
    )
    .map((node) => node.name?.value ?? '');
  return withoutEchoes(kept, values, 60_000).join('\n').slice(0, 60_000);
}
