// cloud.js (完整修复版)

const AV = require('leanengine'); // <-- 这是最关键的修复！

/**
 * 一个简单的云代码方法
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 在文件最底部，粘贴我们之前的代码 ---

const qiniu = require('qiniu');

// 定义一个名为 getQiniuToken 的云函数
AV.Cloud.define('getQiniuToken', (request) => {
  // 再次确认：这里的 key 和 bucket name 都需要替换成您自己的
  const accessKey = 'XxGFSB8qQunIio0qJWEi6F_I61DfPYnnkh7KCFWD';
  const secretKey = 'Zi0BZozrvz4kmJo2DaIkbuVchq2BYCqDsuSxldbh';
  const bucket = 'mychatapp-avatars'; 

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: bucket,
    expires: 3600, 
  };
  const putPolicy = new qiniu.spec.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);
  
  return { token: uploadToken };
});
