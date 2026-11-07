import './styles.css';
import { ViewerApp } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('缺少 #app 容器');
new ViewerApp(root);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 本地开发服务器没有构建产物时，继续保持在线预览功能。
    });
  });
}
