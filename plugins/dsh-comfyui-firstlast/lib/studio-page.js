// 入口再包一层，绕开宿主对 server.js 的模块缓存
export { renderStudio } from './studio.js';
