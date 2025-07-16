// cloud.js (最终正确版)

'use strict';
// 引入 LeanCloud SDK
const AV = require('leanengine');
// 引入七牛云 SDK (确保只引入一次！)
const qiniu = require('qiniu');

/**
 * 一个简单的云代码方法 (模板自带，保留)
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});

// --- 函数 1: 更新用户头像 URL (您的原始函数，保留) ---
AV.Cloud.define('updateAvatar', async (request) => {
  const { avatarUrl } = request.params;
  const currentUser = request.currentUser;

  if (!currentUser) {
    throw new AV.Cloud.Error('用户未登录，无法更新头像。', { code: 401 });
  }

  if (!avatarUrl) {
    throw new AV.Cloud.Error('缺少 avatarUrl 参数。', { code: 400 });
  }

  currentUser.set('avatarUrl', avatarUrl);
  
  await currentUser.save(null, { useMasterKey: true });

  return { success: true, message: '头像更新成功' };
});

// --- 函数 2: 切换角色喜欢状态 (您的原始函数，保留) ---
AV.Cloud.define('toggleLikeCharacter', async (request) => {
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  const { characterId } = request.params;
  if (typeof characterId !== 'number') {
    throw new AV.Cloud.Error('参数 characterId 必须是一个数字。', { code: 400 });
  }

  const likedIds = user.get('likedCharacterIds') || [];
  const index = likedIds.indexOf(characterId);

  if (index > -1) {
    likedIds.splice(index, 1);
  } else {
    likedIds.push(characterId);
  }

  user.set('likedCharacterIds', likedIds);
  await user.save(null, { useMasterKey: true });
  return likedIds;
});

// --- 函数 3: (核心) 获取七牛云上传凭证 (整合后的版本) ---
// 我们将使用这个新版本，它从环境变量读取密钥，更安全
AV.Cloud.define('getQiniuUploadToken', async (request) => {
  // 从环境变量中获取你的七牛云密钥
  const accessKey = process.env.QINIU_AK;
  const secretKey = process.env.QINIU_SK;
  // 你的七牛云空间名
  const bucket = process.env.QINIU_BUCKET_NAME;

  // 检查用户是否登录
  if (!request.currentUser) {
    throw new AV.Cloud.Error('用户未登录，禁止获取上传凭证。', { code: 401 });
  }

  // 检查环境变量是否都已设置
  if (!accessKey || !secretKey || !bucket) {
    console.error('七牛云环境变量未完全设置 (QINIU_AK, QINIU_SK, QINIU_BUCKET_NAME)');
    throw new AV.Cloud.Error('服务器配置错误，无法生成上传凭证。', { code: 500 });
  }

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: bucket,
    expires: 3600, // token 有效期 1 小时
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);

  if (uploadToken) {
    return { token: uploadToken };
  } else {
    throw new AV.Cloud.Error('生成上传凭证失败。', { code: 500 });
  }
});

// 注意：您之前硬编码密钥的 getQiniuToken 函数已被移除，
// 因为 getQiniuUploadToken 是它的更安全、更正确的替代品。
