import './styles.css';
import { ViewerApp } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('缺少 #app 容器');
new ViewerApp(root);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      window.dispatchEvent(new CustomEvent('offline-status', {detail: '离线就绪'}));
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('offline-status', {detail: '当前在线'}));
    });
  });
}
