// cloud.js (最终完整修复版)

const AV = require('leanengine');
const qiniu = require('qiniu');

/**
 * 一个简单的云代码方法 (这是模板自带的，保留即可)
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 函数 1: 获取七牛云上传凭证 ---
AV.Cloud.define('getQiniuToken', (request) => {
  // 请再次确认这里的 key 和 bucket name 都已正确填写
  const accessKey = 'XxGFSB8qQunIio0qJWEi6F_I61DfPYnnkh7KCFWD';
  const secretKey = 'Zi0BZozrvz4kmJo2DaIkbuVchq2BYCqDsuSxldbh';
  const bucket = 'mychatapp-avatars';

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: bucket,
    expires: 3600, 
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);
  
  return { token: uploadToken };
});


// --- 函数 2: (新增) 更新用户头像 URL ---
// 这个函数将以更高权限在服务器端执行，绕开客户端的 ACL 限制
AV.Cloud.define('updateAvatar', async (request) => {
  // 从请求中获取新头像的 URL
  const { avatarUrl } = request.params;
  
  // 获取当前发起请求的用户。这是安全的，LeanCloud 会自动识别。
  const currentUser = request.currentUser;

  if (!currentUser) {
    throw new AV.Cloud.Error('用户未登录，无法更新头像。', { code: 401 });
  }

  if (!avatarUrl) {
    throw new AV.Cloud.Error('缺少 avatarUrl 参数。', { code: 400 });
  }

  // 在服务器端，直接修改当前用户的 avatarUrl 字段
  currentUser.set('avatarUrl', avatarUrl);
  
  // 保存修改。这里使用的是 masterKey，拥有最高权限，无视任何 ACL。
  await currentUser.save(null, { useMasterKey: true });

  return { success: true, message: '头像更新成功' };
});
