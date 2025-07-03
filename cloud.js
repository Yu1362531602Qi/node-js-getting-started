// cloud.js (最终合并版)

// 引入 LeanCloud SDK
const AV = require('leanengine');
// 引入您使用的七牛云 SDK
const qiniu = require('qiniu');

/**
 * 一个简单的云代码方法 (这是模板自带的，保留)
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 函数 1: 获取七牛云上传凭证 (您的原始函数，保留) ---
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


// --- 函数 2: 更新用户头像 URL (您的原始函数，保留) ---
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


// --- 函数 3: (新增) 切换角色喜欢状态 ---
// 这个函数将以更高权限在服务器端执行，绕开客户端的 ACL 限制
AV.Cloud.define('toggleLikeCharacter', async (request) => {
  // 1. 检查用户是否登录
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  // 2. 从请求参数中获取 characterId
  const { characterId } = request.params;
  if (typeof characterId !== 'number') {
    throw new AV.Cloud.Error('参数 characterId 必须是一个数字。', { code: 400 });
  }

  // 3. 获取用户当前的喜欢列表 (如果字段不存在，则默认为空数组)
  const likedIds = user.get('likedCharacterIds') || [];

  // 4. 判断是“喜欢”还是“取消喜欢”
  const index = likedIds.indexOf(characterId);
  if (index > -1) {
    // 如果已存在，则移除（取消喜欢）
    likedIds.splice(index, 1);
  } else {
    // 如果不存在，则添加（喜欢）
    likedIds.push(characterId);
  }

  // 5. 将更新后的数组存回用户对象
  user.set('likedCharacterIds', likedIds);

  // 6. 保存用户对象到数据库
  // 使用 useMasterKey: true 来保存，可以无视任何 ACL 限制，确保操作成功
  await user.save(null, { useMasterKey: true });

  // 7. 返回更新后的喜欢列表给客户端，方便 UI 即时刷新
  return likedIds;
});
