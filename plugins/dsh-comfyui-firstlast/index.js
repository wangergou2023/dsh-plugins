// 入口适配：真正的实现在 server.js（改文件名是为了让宿主重新加载模块，绕开 ESM 缓存）
export { inject, apply } from './server.js';
export { framesForSeconds } from './server.js';