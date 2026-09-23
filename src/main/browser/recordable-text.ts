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
  return nodes
    .filter((node) => !node.ignored && ['StaticText', 'heading'].includes(node.role?.value ?? ''))
    .filter((node) => !inEditable(node))
    .filter(
      (node) =>
        node.role?.value !== 'heading' ||
        (!holdsEditable.has(node.nodeId) && !has(node, 'labelledby')),
    )
    .map((node) => node.name?.value ?? '')
    .join('\n')
    .slice(0, 60_000);
}
