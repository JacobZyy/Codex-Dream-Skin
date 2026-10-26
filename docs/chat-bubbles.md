# 聊天气泡配色 / Chat bubble styles

本 fork 将聊天气泡配色与整体主题分开管理。壁纸、侧栏、输入框、圆角及布局仍归主题；气泡只管理正文前景色、背景色、背景透明度与背景模糊。

## 使用

- macOS：菜单栏 → **聊天气泡配色**。
- Windows：托盘菜单 → **聊天气泡配色**。

选择**跟随主题**，使用作者提供的气泡默认值；旧主题没有新配置时，继续使用其原有 Safe CSS，不会套入新的默认配色。

选择内建预设后进入独立模式。内置松石青绿、雾蓝、烟紫、玫瑰灰、深海青、陶红灰与 Catppuccin Frappé。**自定义…**可编辑完整的四项数值。切换整体主题或修改整体背景透明度，不会替换独立气泡设置。

透明度 0% 为不透明，100% 为全透明，仅影响背景，文字不会一起变淡。模糊范围为 0–64px。普通用户消息、中途补充、回复和过程信息复用同一套气泡配色；原生分组、展开与折叠保持原样。

| 当前模式 | 生效值 | 切换整体主题 |
| --- | --- | --- |
| 跟随主题 | 当前主题的 `chatBubbles`；缺失时沿用其原有 CSS | 气泡跟随新主题 |
| 独立配色 | 本机保存的完整四项快照 | 气泡保持，外围主题正常切换 |

切回跟随主题不会删除最近一次独立配色快照。选择预设会保存当时的完整值，因此后续内建预设更新不会悄悄改变已经选定的颜色。

## 主题作者

在 `theme.json` 中添加可选的完整对象：

```json
{
  "chatBubbles": {
    "foreground": "#BECDE5",
    "background": "#344862",
    "transparency": 25,
    "blur": 24
  }
}
```

两种颜色必须是六位、不含 alpha 的 `#RRGGBB`。四个字段必须完整，不做逐字段继承；未知字段与越界值会被拒绝。背景 alpha 只由 `transparency` 决定，不与整体主题透明度相乘。该对象生效时，四项值覆盖旧的 message Safe CSS；圆角、边框、间距与布局仍按主题配置。

主题包携带作者默认值，不携带本机气泡选择。导入仍只保存主题，不自动切换主题或气泡模式。旧主题无需修改；带 `chatBubbles` 的主题需要支持本功能的 fork 构建，上游 v1.5.21 的严格包校验不支持该新字段。本地开发分支尚未发布新版本或安装包，不应按旧版上游客户端兼容包分发。

## 本机配置与开发接口

配置单独保存在状态目录的 `bubble-preferences.json`，与 `theme-preferences.json` 分离：

```json
{
  "schemaVersion": 1,
  "mode": "preset",
  "presetId": "mist-blue",
  "style": {
    "foreground": "#BECDE5",
    "background": "#344862",
    "transparency": 25,
    "blur": 24
  }
}
```

`mode` 为 `theme` 或 `preset`；后者包含自定义配色。`style` 是实际快照，`presetId` 只记录来源。跟随主题时可以保留快照，但不生效。缺失或损坏的本机配置会回到跟随主题并给出警告，不会把部分错误值混进主题。

共享模块 `runtime/chat-bubbles.mjs` 通过同步工具生成双端资产；原生入口复用同一 CLI，所有写入均经过有界校验与原子替换：

```sh
node runtime/chat-bubbles.mjs list
node runtime/chat-bubbles.mjs get --theme /path/to/theme.json
node runtime/chat-bubbles.mjs preset mist-blue
node runtime/chat-bubbles.mjs theme
node runtime/chat-bubbles.mjs custom --foreground '#BECDE5' --background '#344862' --transparency 25 --blur 24
```

开发测试可以给命令传 `--preferences /path/to/bubble-preferences.json`，避免改动实际用户配置。正常使用请从原生菜单操作；菜单使用客户端现有的受信 Node 校验路径，无需额外安装 Node。

## English

This fork separates bubble styling from the overall wallpaper/theme. Choose **Chat bubble colors → Follow theme**, a built-in preset, or **Custom…** in the macOS menu bar or Windows tray.

Independent styles save a complete snapshot of `foreground`, `background`, `transparency` and `blur`. They survive theme switches and overall transparency changes. Follow theme uses the optional `theme.json.chatBubbles` object; a legacy theme without it keeps its existing CSS. Native grouping and collapse behavior are unchanged.

Colors must be opaque six-digit hex values. Transparency is 0–100% and affects the background only; blur is 0–64px. Bubble settings use a separate local `bubble-preferences.json`, are never exported with a theme, and do not overwrite the source package. These additions require a fork build containing this feature; upstream v1.5.21 does not understand `chatBubbles`.
