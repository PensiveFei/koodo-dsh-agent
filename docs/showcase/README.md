# 截图（showcase）

README 的「实际效果」小节引用这里的图片。

## 当前

| 文件 | 说明 |
| --- | --- |
| `showcase-1.png` | 实机演示 ①（2364×1010） |
| `showcase-2.png` | 实机演示 ②（2184×973） |

两张都是在 Koodo Reader 里实际运行时的截图，已核对包含面板的**签名配色**：
状态点绿 `#3ecf8e`（约 9×9 像素的一小块）与气泡的蓝紫渐变 —— 说明截图时面板确实在屏幕上，
且网关是连通的（状态点为绿）。

## 加新图时

- 文件名：`showcase-<内容>.png`，全小写、连字符分隔
- README 里用 **raw 绝对链接**（这样在 npm / 镜像站看 README 也能显示）：

  ```markdown
  ![智能体面板](https://raw.githubusercontent.com/PensiveFei/koodo-dsh-agent/main/docs/showcase/showcase-panel.png)
  ```

- 截图前注意别把隐私带进去：真实姓名、邮箱、书库路径里的用户名、书名、其它窗口的内容

## 想要「只有面板」的干净截图

面板是固定定位的元素，可以只截它所在的区域。一个不用手工裁剪的办法是走 CDP：
连接 Koodo 的调试端口（启动器带 `--remote-debugging-port`），
用 `Page.captureScreenshot` 的 `clip` 参数裁到面板的包围盒
（取气泡与展开面板两个 `getBoundingClientRect()` 的并集），
再配合 `Emulation.setDeviceMetricsOverride` 的 `deviceScaleFactor: 2` 出 2 倍图。
这样出来的图天然不含书库内容。
