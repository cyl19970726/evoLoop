# 设计基础：颜色、文字、间距与状态

本页定义工作台共用的设计 token、Logo 和状态的视觉表达。数值只在 `packages/ui/src/tokens.css` 维护一份，文档只说明用途和规则。

**目标与现状。** 视觉已定稿（[DEC-037](../decisions.md#用户已确定的方向)）：暖纸底、墨蓝强调、陶土品牌色，浅色为默认，另有一套深色。token 在 `packages/ui/src/tokens.css`，Tailwind 主题在 `packages/ui/src/theme.css`，元素的默认样式（正文字体与行高、文字颜色、等宽数字、键盘焦点框、选中底色、减少动效）在 `packages/ui/src/base.css`，也只引用 token。旧的全局 CSS 和旧变量名已在 #229 PR10 删除，工作台只有一个样式入口 `apps/workbench/src/main.css`，不写规则，页面用 Tailwind 工具类引用 token。`apps/workbench/test/style-budget.test.ts` 固定这几条：颜色字面量只出现在 `tokens.css`（头像插画的配色在 `avatar.tsx`，见下文），工作台不写 CSS 规则，源码里不再有 `data-legacy`。迁移由[前端改版 issue #229](https://github.com/cyl19970726/evoLoop/issues/229) 跟踪。

## 颜色

颜色分两层：基础值只在 token 文件里出现；页面和组件只用下面的用途 token。

### 表面：从后往前

界面分三层：两条左栏直接放在最底层；中间内容和右栏合在一块浮起的“工作面板”里，四周留 8px，圆角 18px，带一层很淡的阴影；面板里的事实卡片、工具步骤、待办清单用柔底色块，不加边框。

| 用途 token | 用途 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `surface-sunken` | 最底层，两条左栏的底色 | `#f2efea` | `#131211` |
| `background` | 工作面板：中间内容与右栏 | `#fbfaf8` | `#1b1a18` |
| `surface-raised` | 浮在面板上的卡片、弹层、输入框、选中的列表项 | `#ffffff` | `#24221f` |
| `surface-muted` | 面板里的柔底色块：事实卡片、工具步骤、待办 | `#f4f1ec` | `#25231f` |
| `surface-field` | 输入底、筛选标签、次要按钮 | `#e9e5de` | `#2a2723` |
| `surface-selected` | 左栏和列表的选中行 | `#e6e1d8` | `#2a2724` |

### 文字、线条与角色

| 用途 token | 用途 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `text` | 正文、标题 | `#1f1d1a` | `#ede9e3` |
| `text-secondary` | 辅助文字 | `#57534e` | `#bdb6ab` |
| `text-muted` | 说明、时间、占位 | `#67615a` | `#958d81` |
| `border` / `border-strong` | 细线 / 强调分隔 | `#ece7df` / `#dcd5ca` | `#2f2c28` / `#403c36` |
| `accent` / `accent-soft` | 链接、选中、进行中 / 选中底色 | `#2f4bb3` / `#e9edfa` | `#93a6f2` / `#26304f` |
| `warning` / `warning-soft` | 等你处理、待验收 | `#965a12` / `#faeedb` | `#e2a55c` / `#3a2b17` |
| `danger` / `danger-soft` | 受阻、失败、返工、危险操作 | `#a9432b` / `#faeae4` | `#e58d73` / `#3b231c` |
| `brand` / `on-brand` | Logo 的对外版本、账号头像、待我处理计数 / 其上的文字 | `#b5582f` / `#ffffff` | `#e08a62` / `#12131a` |
| `user-bubble` | 人发的消息气泡（深色底、浅色字） | `#1f1d1a` | `#2f2c28` |

- 主按钮用墨色：`text` 作底、`background` 作字，每屏最多一个；墨蓝 `accent` 不用来做按钮底色。
- **不使用绿色**，包括青绿、薄荷绿和绿色状态（DEC-029）。“完成、通过、在线”用中性色加图标和文字。
- 颜色之外总有文字或图标；不靠色点表达唯一含义。
- 以上组合都满足 4.5:1 对比度（小字）。`text-muted` 与 `brand` 的定稿值比设计稿略深，就是为此。
- 深色通过 `<html data-theme="dark">` 切换；跟随系统的开关在新外壳（PR5）里加。

## 文字

| token | 大小 | 用途 |
| --- | --- | --- |
| `font-caption` | 12px | 时间、计数、徽标、输入框下方的提示 |
| `font-label` | 13px | 区块小标题、工具摘要、筛选标签 |
| `font-small` | 14px | 界面文字、列表、右栏事实 |
| `font-body` | 16px | 正文阅读（行高 `leading-reading` 1.8） |
| `font-heading` | 20px | 页头标题、区块标题 |
| `font-title` | 28px | 对象标题（任务、文档、交付），每页一个 |

- 字体：系统中文无衬线（`-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`）；代码、命令、技能名用等宽字体。
- 字重三档：常规 400、中等 500（列表标题、按钮）、强调 600（页面与区块标题）。
- 行高三档：正文阅读 1.8，界面 1.55，标题 1.3。正文行宽不超过 `reading-width`（680px）。
- 页面只用 token 类：字号 `text-caption` 到 `text-title`；行高 `leading-(--leading-reading)`、`leading-(--leading-body)`、`leading-(--leading-tight)`。不写 `text-[11px]`、`leading-[1.6]` 这类方括号值，也不用任意属性（`[font-size:…]`）、字号上的行高修饰（`text-small/6`）、内联样式，或 Tailwind 自带、token 之外的档（`text-sm`、`leading-relaxed`、`leading-5`、`leading-tight` 等）。`packages/ui` 的样式表（`tokens.css` 之外）同样只写 `var(--…)`。
- 数字用等宽数字（`tabular-nums`）。中文与数字、英文之间留一个空格。

## 间距、尺寸与圆角

- 间距只用 4、8、12、16、24、36（`space-1` 到 `space-9`）。工作面板外留 8，内容区左右留 36。
- 外层栏 68px，内层栏 264px；按钮高 36px，紧凑控件 30px。
- 圆角五档：行内代码 6px，列表项与输入 10px，卡片与弹层 14px，工作面板与提问卡 18px，按钮、标签、输入框 999px（胶囊），对应 `rounded-sm`、`rounded-md`、`rounded-lg`、`rounded-xl`、`rounded-full`。不写 `rounded-[9px]` 这类方括号值，也不用 `rounded`、`rounded-2xl` 等 token 之外的档。字号、行高和圆角的字面量由 `style-budget.test.ts` 检查，确实需要的写进它的例外表并写明理由（#229 F6 之后为空）。

## 阴影与层级

只有三种东西有阴影：工作面板（`shadow-panel`）、浮在面板上的卡片和选中项（`shadow-control`）、弹出菜单与提示（`shadow-popover`）；弹窗和抽屉用 `shadow-overlay` 并加遮罩 `scrim`。面板内部的区域不加阴影，用柔底色块或细线分隔。焦点用 `focus-ring`：画在元素内侧——外圈 2px 不透明强调色，里面再留 2px 表面色，在任何表面上都看得清（WCAG 2.4.7），也不会被所在的滚动容器裁掉。自身带阴影的控件（选中的页签）和包着输入框的外框（智能体搜索、消息输入框）用同色 2px 向内描边；不自己画焦点的元素（浏览器自动可聚焦的滚动区、`summary`）由基础样式画同色 2px 向内描边，正文里的文字链接描边在文字外侧。工作台的 `focus-ring-ci-browser` 回归按键盘走过关键页，检查每一处都有焦点环且没被裁掉。

## Logo

圆角方块里一条不断开的回环（“方块回环”）：工作交出去、被使用、再回来。文件在 `packages/ui/src/`：

| 文件 | 用途 |
| --- | --- |
| `logo.svg` | 产品内主标：墨蓝底、白色回环；外层栏左上角 36px |
| `logo-dark.svg` | 深色界面：提亮的墨蓝底、深色回环 |
| `logo-small.svg` | 24px 及以下（浏览器标签页图标），回环加粗到 2.8 |

对外页面与社交头像可用陶土底（`brand`）配浅色回环。不加描边、阴影或渐变，不旋转，不单独使用回环，不放在绿色或高饱和底色上。

## 智能体头像

每个智能体有一个卡通头像：**底色区分职责**，发型和配饰区分同一职责下的不同实例。底色取自暖色和蓝紫系，不用绿色。头像在左栏 30px、标题 32–36px、对话流和表格里 16–24px。头像是插画，配色写在 `packages/ui/src/components/avatar.tsx`，不属于用途 token；职责底色按职责 ID 稳定选取，发型与配饰按智能体 ID 选取，统筹和复盘用固定形象。头像组件见[组件清单](components.md)。智能体自选的标识（颜色加图标，显示在名字旁）用 `AgentMark`，配色同样写在 `avatar.tsx`；原来的青绿和橄榄绿换成了青蓝和赭黄（PR6d）。

## 断点

| 宽度 | 行为 |
| --- | --- |
| ≥ 1440px | 外层栏、内层栏、中间、右栏全部展开 |
| 1100–1439px | 右栏默认收起，可展开 |
| 760–1099px | 内层栏可收起；右栏以抽屉打开 |
| < 760px | 外层栏变成底部标签栏；内层栏和右栏变成从底部升起的速览 |

只用这几个断点，页面里不另写断点。具体布局见[布局](layout.md)。

## 动效

| token | 时长 | 用途 |
| --- | --- | --- |
| `duration-fast` | 150ms | 悬停、按下、小元素出现 |
| `duration-base` | 200ms | 展开收起、面板进出 |
| `duration-slow` | 250ms | 抽屉、弹窗 |

缓动统一用减速曲线（ease-out）。尊重 `prefers-reduced-motion`。使用原则见[设计原则](principles.md#动效)。

## 状态的视觉表达

| 状态 | 颜色 | 图标 | 文字示例 |
| --- | --- | --- | --- |
| 进行中、运行中 | `accent` | 旋转的加载图标 | 正在运行测试 · 1 分 04 秒 |
| 完成、通过 | `text-secondary`（中性） | 勾 | 已验收 |
| 等你处理、待验收、等你回答 | `warning` | 时钟 | 待验收 |
| 受阻、失败、待返工 | `danger` | 警示三角 | 待返工 |
| 待办、空闲 | `text-secondary`，底色 `surface-field` | 无 | 待办 |
| 未知、过期、未核对 | `text-muted` | 问号 | 状态未核对 |
| 历史、已取消 | `text-muted` | 无 | 历史承接 |
| 机器在线 / 离线 | `accent` / `text-muted` | 圆点 | 在线 / 离线 |

状态标签是胶囊形：浅底色加同色系文字（例如 `danger-soft` 底、`danger` 字）。由一个组件统一渲染（见[组件清单](components.md)），业务状态到这张表的映射放在工作台的共享层，各页不各写一套。
