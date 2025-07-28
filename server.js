'use strict';
const AV = require('leanengine');
const app = require('./app'); // 引入 Express app 实例

// 引入我们 cloud.js 中导出的处理器
const { streamProxyApiCallHandler } = require('./cloud');

// 定义端口
const PORT = parseInt(process.env.LEANCLOUD_APP_PORT || process.env.PORT || 3000);

// 注册自定义的 Express 路由
// 这个路由会匹配 /1.1/functions/streamProxyApiCall
// LeanEngine SDK 会自动为云函数创建 /1.1/functions/ 前缀
// 但为了保险起见，我们手动定义完整的路径
app.post('/1.1/functions/streamProxyApiCall', streamProxyApiCallHandler);

// 启动服务器
app.listen(PORT, function (err) {
  if (err) {
    return console.error(err);
  }
  console.log('Node app is running on port:', PORT);
});
