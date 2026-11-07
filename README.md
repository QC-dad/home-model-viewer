# 手机离线户型查看器

TypeScript、Vite、Three.js 实现的本地模型查看与家具试摆工具。仓库只包含通用程序；模型、参考图、材质与布局通过设备上的 ZIP / JSON 文件导入。

## 使用

1. iPhone 用 Safari、安卓用 Chrome 打开发布地址，添加到主屏幕。
2. 从主屏幕打开，首次联网等待“离线就绪”，导入符合 [MODEL_FORMAT.md](MODEL_FORMAT.md) 的模型 ZIP。
3. 切换楼层或房间视角；开启编辑后拖动家具，选择替换款、旋转、撤销或恢复房间。
4. “备份布局”导出 JSON；在另一设备导入同版本模型后，“恢复 JSON”读取备份。

应用壳由 Service Worker 完整缓存，模型与布局保存在 IndexedDB。关闭电脑不影响已缓存的手机使用；清理网站数据后需重新导入备份。iPhone 主屏幕应用和浏览器标签可能有各自的存储，建议在主屏幕应用中导入。

## 开发与发布

```sh
npm ci
npm test
npm run dev
npm run build
npm run preview
```

GitHub Pages 使用仓库内的 Actions 工作流，需在仓库 Pages 设置中选择 GitHub Actions。相对路径支持项目子目录。每次发布使用独立缓存版本，模型与布局存储保持不变。

## 已实现

- 全屋/楼层、房间视角、旋转缩放平移、材质/白模/四向可调剖切。
- 建筑闭合切面的填充与截线；开放单面构件只显示截线。
- 家具替换、米制位置和朝向、楼层边界约束、重叠提示、撤销及房间复位。
- 本地 ZIP 与布局 JSON 校验、失败保留当前项目、自动保存。
- 柔和阴影、环境光和接触阴影；持续低帧率时自动降低渲染分辨率、再关闭屏幕空间遮蔽。

手机帧率与离线冷启动时间需按实际模型和实际设备验收。运行信息中的“渲染三角面”是当前绘制统计，含后处理时与模型文件中的几何面数不同。

实现依据：[Service Worker 离线机制](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)、[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
