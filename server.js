'use strict';
const AV = require('leanengine');

AV.init({
  appId: process.env.LEANCLOUD_APP_ID,
  appKey: process.env.LEANCLOUD_APP_KEY,
  masterKey: process.env.LEANCLOUD_APP_MASTER_KEY
});

// 如果您不希望使用 masterKey，可以注释掉下面这行
AV.Cloud.useMasterKey();

const app = require('./app');

// --- vvv 核心新增：从 cloud.js 引入我们的自定义处理器 vvv ---
const { streamProxyApiCallHandler } = require('./cloud');
// --- ^^^ 核心新增 ^^^ ---

// 从环境变量中获取端口号
const PORT = parseInt(process.env.LEANCLOUD_APP_PORT || process.env.PORT || 3000);

// --- vvv 核心新增：在 app.listen 之前注册我们的自定义路由 vvv ---
// 这个路由路径必须与客户端 ApiClient 中请求的路径完全一致
app.post('/1.1/functions/streamProxyApiCall', streamProxyApiCallHandler);
// --- ^^^ 核心新增 ^^^ ---

app.listen(PORT, (err) => {
  if (err) {
    return console.error(err);
  }
  console.log('Node app is running on port:', PORT);

  // 注册全局未捕获异常处理器
  process.on('uncaughtException', err => {
    console.error('Caught exception:', err.stack);
  });
  process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at: Promise ', p, ' reason: ', reason.stack);
  });
});
