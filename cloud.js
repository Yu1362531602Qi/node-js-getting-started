// cloud.js (最终修复版)

const AV = require('leanengine');
const qiniu = require('qiniu');

/**
 * 一个简单的云代码方法 (这是模板自带的，保留即可)
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 这是我们自己的云函数，使用了七牛云 SDK 的最新 API ---

AV.Cloud.define('getQiniuToken', (request) => {
  // 再次确认：这里的 key 和 bucket name 都需要替换成您自己的
  const accessKey = 'XxGFSB8qQunIio0qJWEi6F_I61DfPYnnkh7KCFWD';
  const secretKey = 'Zi0BZozrvz4kmJo2DaIkbuVchq2BYCqDsuSxldbh';
  const bucket = 'mychatapp-avatars';

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  
  // --- 核心修复：使用新的 qiniu.rs.PutPolicy 替代旧的 qiniu.spec.PutPolicy ---
  const options = {
    scope: bucket,
    expires: 3600, // token 有效期 1 小时
  };
  const putPolicy = new qiniu.rs.PutPolicy(options); // <-- 使用正确的 API
  
  const uploadToken = putPolicy.uploadToken(mac);
  
  return { token: uploadToken };
});
