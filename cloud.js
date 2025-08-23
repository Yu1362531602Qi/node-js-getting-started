// cloud.js (V4.9 - 关注/粉丝功能安全加固)
// 变更日志:
// - 安全增强: `followUser` 和 `unfollowUser` 函数现在会验证目标用户是否存在，防止关注不存在的用户。
// - 稳定性修复: `getFollowers` 和 `getFollowing` 函数现在会过滤掉因用户被删除而产生的无效数据，修复了粉丝列表页的崩溃问题。
// - 修复: `secureRegister` 云函数不再尝试登录，只负责创建用户并返回成功状态。
// - 流程变更: 客户端在接收到注册成功的回调后，将自动发起一次标准的登录请求来获取 sessionToken。

'use strict';
const AV = require('leanengine');
const qiniu = require('qiniu');
const crypto = require('crypto');

// =================================================================
// == 安全校验与角色管理核心模块
// =================================================================

const validateSessionAuth = (request) => {
  const sessionAuthToken = request.expressReq.get('X-Session-Auth-Token');
  if (!sessionAuthToken) {
    throw new AV.Cloud.Error('无效的客户端，禁止操作。', { code: 403 });
  }
  const endpoint = request.functionName || request.expressReq.path || 'unknown';
  console.log(`Session Auth Token 校验通过，端点: ${endpoint}`);
};

AV.Cloud.define('handshake', async (request) => {
  const { version, timestamp, signature } = request.params;
  if (!version || !timestamp || !signature) {
    throw new AV.Cloud.Error('无效的握手请求，缺少参数。', { code: 400 });
  }
  const clientTimestamp = parseInt(timestamp, 10);
  const serverTimestamp = Math.floor(Date.now() / 1000);
  if (Math.abs(serverTimestamp - clientTimestamp) > 300) {
    throw new AV.Cloud.Error('请求已过期或设备时间不正确。', { code: 408 });
  }
  const rootKey = process.env.CLIENT_ROOT_KEY;
  if (!rootKey) {
      console.error('FATAL: 环境变量 CLIENT_ROOT_KEY 未设置！');
      throw new AV.Cloud.Error('服务器内部配置错误。', { code: 500 });
  }
  const challengeData = `${version}|${timestamp}`;
  const hmac = crypto.createHmac('sha256', rootKey);
  hmac.update(challengeData);
  const serverSignature = hmac.digest('hex');
  if (serverSignature !== signature) {
    console.error(`签名验证失败！客户端签名: ${signature}, 服务器计算签名: ${serverSignature}`);
    throw new AV.Cloud.Error('签名验证失败。', { code: 403 });
  }
  console.log(`版本 ${version} 的客户端握手成功。`);
  const versionQuery = new AV.Query('VersionConfig');
  versionQuery.equalTo('versionName', version);
  const versionConfig = await versionQuery.first({ useMasterKey: true });
  let status = 'blocked';
  let updateMessage = '您的应用版本不受支持，请更新。';
  let updateUrl = '';
  let sessionAuthToken = null;
  if (versionConfig) {
    status = versionConfig.get('status');
    updateMessage = versionConfig.get('updateMessage');
    updateUrl = versionConfig.get('updateUrl');
  }
  if (status === 'active') {
    sessionAuthToken = crypto.randomBytes(32).toString('hex');
  }
  return {
    status: status,
    updateMessage: updateMessage,
    updateUrl: updateUrl,
    sessionAuthToken: sessionAuthToken,
  };
});

const getUserRoles = async (request) => {
    if (request.userRoles) {
        console.log(`[Auth] 从请求缓存中获取用户 ${request.currentUser.id} 的角色: [${request.userRoles.join(', ')}]`);
        return request.userRoles;
    }

    const user = request.currentUser;
    if (!user) return ['User'];

    const roleQuery = new AV.Query(AV.Role);
    roleQuery.equalTo('users', user);
    
    const roles = await roleQuery.find({ useMasterKey: true });
    const roleNames = roles.map(role => role.get('name'));
    
    if (!roleNames.includes('User')) {
        roleNames.push('User');
    }
    
    console.log(`[Auth] 最终确认用户 ${user.id} 的角色为: [${roleNames.join(', ')}]`);
    request.userRoles = roleNames;
    return roleNames;
};


// =================================================================
// == API 调用限制模块
// =================================================================

async function checkAndIncrementUsage(user, usageType, permissions) {
    const today = new Date().toISOString().slice(0, 10);
    const lastCallDate = user.get('lastCallDate');
    const usageCountField = `${usageType}CallCount`;
    let currentUsage = user.get(usageCountField) || 0;
    let needsSave = false;

    if (lastCallDate !== today) {
        console.log(`用户 ${user.id} 在新的一天 (${today}) 首次调用，重置所有计数器。`);
        user.set('lastCallDate', today);
        user.set('llmCallCount', 0);
        user.set('ttsCallCount', 0);
        currentUsage = 0;
        needsSave = true;
    }

    const limitField = `${usageType}Limit`;
    const dailyLimit = Math.max(...permissions.map(p => p.get(limitField) || 0));
    const userRoles = permissions.map(p => p.get('roleName'));

    console.log(`用户 ${user.id} (角色: ${userRoles.join(', ')}) 的 ${usageType} 限额为 ${dailyLimit}，当前已用 ${currentUsage}`);

    if (currentUsage >= dailyLimit) {
        throw new AV.Cloud.Error(`您今日的${usageType === 'llm' ? '语言模型' : '语音'}调用次数已达上限 (${dailyLimit}次)。`, { code: 429 });
    }

    user.increment(usageCountField, 1);
    needsSave = true;
    
    if (needsSave) {
        try {
            await user.save(null, { useMasterKey: true });
            console.log(`用户 ${user.id} 的 ${usageCountField} 计数更新成功。`);
        } catch (error) {
            console.error(`为用户 ${user.id} 更新用量计数失败:`, error);
            throw new AV.Cloud.Error('更新用户用量失败，请重试。', { code: 500 });
        }
    }
}

AV.Cloud.define('requestApiCallPermission', async (request) => {
    validateSessionAuth(request);
    const user = request.currentUser;
    if (!user) {
        throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
    }

    const userRoles = await getUserRoles(request);

    if (userRoles.includes('Admin')) {
        console.log(`管理员 ${user.get('username')} 请求调用许可，直接通过。`);
        return { 
            canCall: true, 
            message: '管理员权限，许可已授予。',
            historyLimit: -1 
        };
    }

    const { usageType } = request.params;
    if (usageType !== 'llm' && usageType !== 'tts') {
        throw new AV.Cloud.Error('无效的 usageType 参数，必须是 "llm" 或 "tts"。', { code: 400 });
    }

    const permissionQuery = new AV.Query('RolePermission');
    permissionQuery.containedIn('roleName', userRoles);
    const permissions = await permissionQuery.find({ useMasterKey: true });

    if (permissions.length === 0) {
        console.error(`未找到任何与用户角色 ${userRoles.join(', ')} 匹配的权限配置！`);
        throw new AV.Cloud.Error('服务器权限配置错误，请联系管理员。', { code: 500 });
    }

    const historyLimit = Math.max(...permissions.map(p => p.get('historyLimit') ?? 15));

    try {
        await checkAndIncrementUsage(user, usageType, permissions);
        return { 
            canCall: true, 
            message: '许可已授予。',
            historyLimit: historyLimit 
        };
    } catch (error) {
        console.log(`用户 ${user.id} 的 ${usageType} 调用被拒绝: ${error.message}`);
        return { 
            canCall: false, 
            message: error.message,
            historyLimit: 0
        };
    }
});


// =================================================================
// == 业务云函数
// =================================================================

AV.Cloud.define('secureRegister', async (request) => {
  const { username, email, password, deviceId } = request.params;

  if (!username || !email || !password || !deviceId) {
    throw new AV.Cloud.Error('所有字段均为必填项。', { code: 400 });
  }
  
  console.log(`收到新用户注册请求，开始校验设备ID: ${deviceId}`);
  const deviceQuery = new AV.Query('_User');
  deviceQuery.equalTo('deviceId', deviceId);
  const existingUserByDevice = await deviceQuery.first({ useMasterKey: true });

  if (existingUserByDevice) {
    console.warn(`注册请求被拒绝：设备ID "${deviceId}" 已被用户 ${existingUserByDevice.id} 注册。`);
    throw new AV.Cloud.Error('该设备已注册过账户，请直接登录。', { code: 409 });
  }
  console.log(`设备ID "${deviceId}" 校验通过。`);

  const user = new AV.User();
  user.set('username', username);
  user.set('password', password);
  user.set('email', email);
  user.set('deviceId', deviceId);

  try {
    await user.signUp(null, { useMasterKey: true });
    console.log(`新用户 ${username} (${user.id}) 已在数据库中创建。`);
    return { success: true, message: '注册成功' };
  } catch (error) {
    console.error(`用户 ${username} 注册失败:`, error);
    throw new AV.Cloud.Error(error.message || '注册时发生未知错误。', { code: error.code || 500 });
  }
});

AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});

AV.Cloud.define('test_addUserToRole', async (request) => {
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }

  const { targetUserId, roleName } = request.params;
  if (!targetUserId || !roleName) {
    throw new AV.Cloud.Error('参数缺失，需要提供 targetUserId 和 roleName。', { code: 400 });
  }

  try {
    const roleQuery = new AV.Query(AV.Role);
    roleQuery.equalTo('name', roleName);
    const targetRole = await roleQuery.first({ useMasterKey: true });

    if (!targetRole) {
      throw new AV.Cloud.Error(`名为 "${roleName}" 的角色不存在，请先在 _Role 表中创建。`, { code: 404 });
    }

    const userToAdd = AV.Object.createWithoutData('_User', targetUserId);
    const relation = targetRole.relation('users');
    relation.add(userToAdd);
    await targetRole.save(null, { useMasterKey: true });

    const successMessage = `成功！已将用户 ${targetUserId} 添加到角色 "${roleName}" 中。`;
    console.log(successMessage);
    return { success: true, message: successMessage };

  } catch (error) {
    console.error(`[test_addUserToRole] 操作失败:`, error);
    throw new AV.Cloud.Error(error.message, { code: error.code || 500 });
  }
});

// --- 用户与个人资料 ---
AV.Cloud.define('updateUserProfile', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { username, bio } = request.params;
  if (username !== undefined) {
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2 || trimmedUsername.length > 15) {
      throw new AV.Cloud.Error('昵称长度必须在 2 到 15 个字符之间。', { code: 400 });
    }
    if (trimmedUsername !== user.get('username')) {
        const query = new AV.Query('_User');
        query.equalTo('username', trimmedUsername);
        const existingUser = await query.first();
        if (existingUser) {
            throw new AV.Cloud.Error('该昵称已被使用。', { code: 409 });
        }
    }
    user.set('username', trimmedUsername);
  }
  if (bio !== undefined) {
    if (typeof bio !== 'string' || bio.length > 100) {
      throw new AV.Cloud.Error('个性签名不能超过 100 个字符。', { code: 400 });
    }
    user.set('bio', bio);
  }
  try {
    await user.save(null, { useMasterKey: true });
    return { success: true, message: '个人资料更新成功' };
  } catch (error) {
    console.error(`更新用户 ${user.id} 资料失败:`, error);
    if (error.code === 202) {
         throw new AV.Cloud.Error('该昵称已被使用。', { code: 409 });
    }
    throw new AV.Cloud.Error('更新失败，请稍后再试。', { code: 500 });
  }
});

AV.Cloud.define('getQiniuUserAvatarUploadToken', async (request) => {
  validateSessionAuth(request);
  if (!request.currentUser) {
    throw new AV.Cloud.Error('用户未登录，禁止获取上传凭证。', { code: 401 });
  }
  const userId = request.currentUser.id;
  const accessKey = process.env.QINIU_AK;
  const secretKey = process.env.QINIU_SK;
  const bucket = process.env.QINIU_BUCKET_NAME;
  if (!accessKey || !secretKey || !bucket) {
    console.error('七牛云环境变量未完全设置 (QINIU_AK, QINIU_SK, QINIU_BUCKET_NAME)');
    throw new AV.Cloud.Error('服务器配置错误，无法生成上传凭证。', { code: 500 });
  }
  const key = `user_avatars/${userId}/${Date.now()}.jpg`;
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: `${bucket}:${key}`,
    expires: 3600,
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);
  if (uploadToken) {
    return { token: uploadToken, key: key };
  } else {
    throw new AV.Cloud.Error('生成上传凭证失败。', { code: 500 });
  }
});

AV.Cloud.define('saveUserAvatarUrl', async (request) => {
  validateSessionAuth(request);
  const currentUser = request.currentUser;
  if (!currentUser) {
    throw new AV.Cloud.Error('用户未登录，无法更新头像。', { code: 401 });
  }
  const { key: newKey } = request.params;
  if (!newKey) {
    throw new AV.Cloud.Error('缺少 key 参数。', { code: 400 });
  }
  const bucketUrl = process.env.QINIU_BUCKET_URL;
  if (!bucketUrl) {
      console.error('七牛云环境变量 QINIU_BUCKET_URL 未设置');
      throw new AV.Cloud.Error('服务器配置错误，无法生成头像URL。', { code: 500 });
  }
  const oldAvatarUrl = currentUser.get('avatarUrl');
  const newAvatarUrl = `${bucketUrl}/${newKey}`;
  currentUser.set('avatarUrl', newAvatarUrl);
  await currentUser.save(null, { useMasterKey: true });
  if (oldAvatarUrl) {
    try {
      const oldKey = oldAvatarUrl.replace(bucketUrl + '/', '');
      if (oldKey && oldKey !== newKey && oldKey.startsWith('user_avatars/')) {
        console.log(`准备删除旧头像，Key: ${oldKey}`);
        const accessKey = process.env.QINIU_AK;
        const secretKey = process.env.QINIU_SK;
        const bucket = process.env.QINIU_BUCKET_NAME;
        const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
        const config = new qiniu.conf.Config();
        const bucketManager = new qiniu.rs.BucketManager(mac, config);
        await new Promise((resolve, reject) => {
          bucketManager.delete(bucket, oldKey, (err, respBody, respInfo) => {
            if (err) {
              reject(err);
            } else {
              if (respInfo.statusCode == 200) {
                resolve(respBody);
              } else {
                if (respInfo.statusCode !== 612) {
                   reject(new Error(`删除失败，状态码: ${respInfo.statusCode}, 信息: ${JSON.stringify(respBody)}`));
                } else {
                   console.log(`旧文件(Key: ${oldKey})在七牛云不存在，无需删除。`);
                   resolve(respBody);
                }
              }
            }
          });
        });
        console.log(`成功删除旧头像: ${oldKey}`);
      }
    } catch (e) {
      console.error(`删除旧头像(URL: ${oldAvatarUrl})时发生错误:`, e);
    }
  }
  return { success: true, avatarUrl: newAvatarUrl };
});

// --- 关注/粉丝相关云函数 ---
AV.Cloud.define('followUser', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { targetUserId } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  if (user.id === targetUserId) {
    throw new AV.Cloud.Error('不能关注自己。', { code: 400 });
  }

  // --- vvv 核心修复 1：验证目标用户是否存在 vvv ---
  try {
    const targetUserQuery = new AV.Query('_User');
    await targetUserQuery.get(targetUserId, { useMasterKey: true });
  } catch (error) {
    // 如果 get 方法出错（通常是 not found），则说明用户不存在
    console.warn(`用户 ${user.id} 尝试关注一个不存在的用户 ${targetUserId}`);
    throw new AV.Cloud.Error('目标用户不存在。', { code: 404 });
  }
  // --- ^^^ 核心修复 1 ^^^ ---

  const followQuery = new AV.Query('UserFollow');
  followQuery.equalTo('user', user);
  followQuery.equalTo('followed', AV.Object.createWithoutData('_User', targetUserId));
  const existingFollow = await followQuery.first();
  if (existingFollow) {
    console.log(`用户 ${user.id} 已关注 ${targetUserId}，无需重复操作。`);
    return { success: true, message: '已关注' };
  }
  const Follow = AV.Object.extend('UserFollow');
  const newFollow = new Follow();
  newFollow.set('user', user);
  newFollow.set('followed', AV.Object.createWithoutData('_User', targetUserId));
  const acl = new AV.ACL();
  acl.setReadAccess(user, true);
  acl.setWriteAccess(user, true);
  newFollow.setACL(acl);
  await newFollow.save(null, { useMasterKey: true });
  const followerUpdate = user.increment('followingCount', 1);
  const followedUser = AV.Object.createWithoutData('_User', targetUserId);
  const followedUpdate = followedUser.increment('followersCount', 1);
  await AV.Object.saveAll([followerUpdate, followedUpdate], { useMasterKey: true });
  return { success: true, message: '关注成功' };
});

AV.Cloud.define('unfollowUser', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { targetUserId } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const followQuery = new AV.Query('UserFollow');
  followQuery.equalTo('user', user);
  followQuery.equalTo('followed', AV.Object.createWithoutData('_User', targetUserId));
  const followRecord = await followQuery.first();
  if (!followRecord) {
    console.log(`用户 ${user.id} 未关注 ${targetUserId}，无需取消。`);
    return { success: true, message: '未关注' };
  }
  await followRecord.destroy({ useMasterKey: true });
  const followerUpdate = user.increment('followingCount', -1);
  const followedUser = AV.Object.createWithoutData('_User', targetUserId);
  const followedUpdate = followedUser.increment('followersCount', -1);
  await AV.Object.saveAll([followerUpdate, followedUpdate], { useMasterKey: true });
  return { success: true, message: '取消关注成功' };
});

AV.Cloud.define('getFollowers', async (request) => {
  validateSessionAuth(request);
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const targetUser = AV.Object.createWithoutData('_User', targetUserId);
  const query = new AV.Query('UserFollow');
  query.equalTo('followed', targetUser);
  query.include('user');
  query.select('user.username', 'user.avatarUrl', 'user.objectId');
  query.skip((page - 1) * limit);
  query.limit(limit);
  query.descending('createdAt');
  const results = await query.find();
  // --- vvv 核心修复 2：过滤掉已不存在的用户 vvv ---
  return results.map(follow => follow.get('user')).filter(user => user);
  // --- ^^^ 核心修复 2 ^^^ ---
});

AV.Cloud.define('getFollowing', async (request) => {
  validateSessionAuth(request);
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const targetUser = AV.Object.createWithoutData('_User', targetUserId);
  const query = new AV.Query('UserFollow');
  query.equalTo('user', targetUser);
  query.include('followed');
  query.select('followed.username', 'followed.avatarUrl', 'followed.objectId');
  query.skip((page - 1) * limit);
  query.limit(limit);
  query.descending('createdAt');
  const results = await query.find();
  // --- vvv 核心修复 2：过滤掉已不存在的用户 vvv ---
  return results.map(follow => follow.get('followed')).filter(user => user);
  // --- ^^^ 核心修复 2 ^^^ ---
});

// --- 角色与创作管理 ---
AV.Cloud.define('generateNewLocalCharacterId', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，无法生成ID。', { code: 401 });
  }
  const updatedUser = await user.increment('localCharIdCounter', -1).save(null, {
    fetchWhenSave: true,
    useMasterKey: true
  });
  const newId = updatedUser.get('localCharIdCounter');
  return newId;
});

AV.Cloud.define('toggleLikeCharacter', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { characterId } = request.params;
  if (typeof characterId !== 'number') {
    throw new AV.Cloud.Error('参数 characterId 必须是一个数字。', { code: 400 });
  }
  const charQuery = new AV.Query('Character');
  charQuery.equalTo('id', characterId);
  const character = await charQuery.first({ useMasterKey: true });
  if (!character) {
    console.warn(`未在 Character 表中找到 id 为 ${characterId} 的角色，将只更新用户喜欢列表。`);
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
  }
  const likedIds = user.get('likedCharacterIds') || [];
  const index = likedIds.indexOf(characterId);
  let incrementAmount = 0;
  if (index > -1) {
    likedIds.splice(index, 1);
    incrementAmount = -1;
  } else {
    likedIds.push(characterId);
    incrementAmount = 1;
  }
  user.set('likedCharacterIds', likedIds);
  character.increment('likeCount', incrementAmount);
  try {
    await AV.Object.saveAll([user, character], { useMasterKey: true });
  } catch (error) {
    console.error(`原子性保存用户和角色失败:`, error);
    throw new AV.Cloud.Error('更新点赞状态失败，请重试。', { code: 500 });
  }
  return likedIds;
});

AV.Cloud.define('incrementChatCount', async (request) => {
  validateSessionAuth(request);
  if (!request.currentUser) {
    console.log("未登录用户尝试增加聊天计数，已忽略。");
    return { success: true, message: "Ignored for anonymous user." };
  }
  const { characterId } = request.params;
  if (typeof characterId !== 'number') {
    throw new AV.Cloud.Error('参数 characterId 必须是一个数字。', { code: 400 });
  }
  const charQuery = new AV.Query('Character');
  charQuery.equalTo('id', characterId);
  const character = await charQuery.first({ useMasterKey: true });
  if (character) {
    character.increment('chatCount', 1);
    await character.save(null, { useMasterKey: true });
    return { success: true, message: `Character ${characterId} chat count incremented.` };
  } else {
    console.warn(`尝试为不存在的角色 (id: ${characterId}) 增加聊天计数。`);
    return { success: false, message: `Character with id ${characterId} not found.` };
  }
});

AV.Cloud.define('getQiniuUploadToken', async (request) => {
  validateSessionAuth(request);
  const accessKey = process.env.QINIU_AK;
  const secretKey = process.env.QINIU_SK;
  const bucket = process.env.QINIU_BUCKET_NAME;
  if (!request.currentUser) {
    throw new AV.Cloud.Error('用户未登录，禁止获取上传凭证。', { code: 401 });
  }
  if (!accessKey || !secretKey || !bucket) {
    console.error('七牛云环境变量未完全设置 (QINIU_AK, QINIU_SK, QINIU_BUCKET_NAME)');
    throw new AV.Cloud.Error('服务器配置错误，无法生成上传凭证。', { code: 500 });
  }
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: bucket,
    expires: 3600,
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);
  if (uploadToken) {
    return { token: uploadToken };
  } else {
    throw new AV.Cloud.Error('生成上传凭证失败。', { code: 500 });
  }
});

AV.Cloud.define('getSubmissionStatuses', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { localIds } = request.params;
  if (!Array.isArray(localIds) || localIds.length === 0) {
    return {};
  }
  const submissionQuery = new AV.Query('CharacterSubmissions');
  submissionQuery.equalTo('submitter', user);
  submissionQuery.containedIn('localId', localIds); 
  submissionQuery.select(['localId', 'status']);
  submissionQuery.limit(1000);
  const submissions = await submissionQuery.find();
  const statuses = {};
  for (const submission of submissions) {
    statuses[submission.get('localId')] = submission.get('status');
  }
  return statuses;
});

// --- 搜索功能 ---
AV.Cloud.define('searchPublicContent', async (request) => {
  validateSessionAuth(request);
  const { searchText } = request.params;
  if (!searchText || searchText.trim().length < 1) {
    return { characters: [], users: [] };
  }
  const characterNameQuery = new AV.Query('Character');
  characterNameQuery.contains('name', searchText);
  const characterDescQuery = new AV.Query('Character');
  characterDescQuery.contains('description', searchText);
  const characterTagQuery = new AV.Query('Character');
  characterTagQuery.equalTo('tags', searchText); 
  const characterQuery = AV.Query.or(characterNameQuery, characterDescQuery, characterTagQuery);
  characterQuery.limit(20);
  const usernameQuery = new AV.Query('_User');
  usernameQuery.contains('username', searchText);
  const userIdQuery = new AV.Query('_User');
  userIdQuery.equalTo('objectId', searchText);
  const userQuery = AV.Query.or(usernameQuery, userIdQuery);
  userQuery.select(['username', 'avatarUrl', 'objectId']);
  userQuery.limit(10);
  try {
    const [characterResults, userResults] = await Promise.all([
      characterQuery.find(),
      userQuery.find()
    ]);
    return {
      characters: characterResults,
      users: userResults,
    };
  } catch (error) {
    console.error('搜索时发生错误:', error);
    throw new AV.Cloud.Error('搜索失败，请稍后再试。', { code: 500 });
  }
});

// --- 用户主页 ---
AV.Cloud.define('getUserPublicProfile', async (request) => {
  validateSessionAuth(request);
  const { userId } = request.params;
  const currentUser = request.currentUser;
  if (!userId) {
    throw new AV.Cloud.Error('必须提供 userId 参数。', { code: 400 });
  }
  const userQuery = new AV.Query('_User');
  userQuery.select(['username', 'avatarUrl', 'objectId', 'followingCount', 'followersCount', 'bio']);
  const user = await userQuery.get(userId, { useMasterKey: true });
  if (!user) {
    throw new AV.Cloud.Error('用户不存在。', { code: 404 });
  }
  const creationsCountQuery = new AV.Query('Character');
  creationsCountQuery.equalTo('author', AV.Object.createWithoutData('_User', userId));
  const creationsCount = await creationsCountQuery.count({ useMasterKey: true });
  let totalLikes = 0;
  let hasMore = true;
  let skip = 0;
  const limit = 1000;
  while (hasMore) {
    const likesQuery = new AV.Query('Character');
    likesQuery.equalTo('author', AV.Object.createWithoutData('_User', userId));
    likesQuery.select(['likeCount']);
    likesQuery.limit(limit);
    likesQuery.skip(skip);
    const characters = await likesQuery.find({ useMasterKey: true });
    if (characters.length > 0) {
      for (const char of characters) {
        totalLikes += char.get('likeCount') || 0;
      }
      skip += characters.length;
    } else {
      hasMore = false;
    }
  }
  const stats = {
    following: user.get('followingCount') || 0,
    followers: user.get('followersCount') || 0,
    likesReceived: totalLikes,
    creations: creationsCount,
  };
  let isFollowing = false;
  if (currentUser && currentUser.id !== userId) {
    const followQuery = new AV.Query('UserFollow');
    followQuery.equalTo('user', currentUser);
    followQuery.equalTo('followed', user);
    const followRecord = await followQuery.first();
    if (followRecord) {
      isFollowing = true;
    }
  }
  return {
    user: user.toJSON(),
    stats: stats,
    isFollowing: isFollowing,
  };
});

AV.Cloud.define('getUserCreations', async (request) => {
  validateSessionAuth(request);
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const creationsQuery = new AV.Query('Character');
  creationsQuery.equalTo('author', AV.Object.createWithoutData('_User', targetUserId));
  creationsQuery.descending('createdAt');
  creationsQuery.skip((page - 1) * limit);
  creationsQuery.limit(limit);
  const characters = await creationsQuery.find({ useMasterKey: true });
  return characters.map(char => char.toJSON());
});

// --- 新增：主页多维发现云函数 ---
AV.Cloud.define('getFollowingFeed', async (request) => {
  validateSessionAuth(request);
  const user = request.currentUser;
  if (!user) {
    return [];
  }
  const { page = 1, limit = 20 } = request.params;
  const followQuery = new AV.Query('UserFollow');
  followQuery.equalTo('user', user);
  followQuery.select('followed');
  followQuery.limit(1000);
  const followings = await followQuery.find({ useMasterKey: true });
  if (followings.length === 0) {
    return [];
  }
  const followedUsers = followings.map(f => f.get('followed'));
  const feedQuery = new AV.Query('Character');
  feedQuery.containedIn('author', followedUsers);
  feedQuery.descending('createdAt');
  feedQuery.skip((page - 1) * limit);
  feedQuery.limit(limit);
  feedQuery.include('author');
  const characters = await feedQuery.find({ useMasterKey: true });
  return characters.map(char => char.toJSON());
});


// =================================================================
// == 管理员后台功能
// =================================================================

AV.Cloud.define('publishApprovedCharacters', async (request) => {
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }
  const submissionQuery = new AV.Query('CharacterSubmissions');
  submissionQuery.equalTo('status', 'approved');
  submissionQuery.include('submitter');
  const submissions = await submissionQuery.find();

  if (submissions.length === 0) {
    return '没有找到待发布的角色。';
  }

  const charQuery = new AV.Query('Character');
  charQuery.descending('id');
  charQuery.limit(1);
  const maxIdChar = await charQuery.first();
  let maxId = maxIdChar ? maxIdChar.get('id') : 0;

  let successCount = 0;
  const failedSubmissions = [];

  for (const submission of submissions) {
    try {
      const submissionData = submission.get('characterData');
      const imageUrl = submission.get('imageUrl');
      const submitter = submission.get('submitter');

      const newId = ++maxId;
      const Character = AV.Object.extend('Character');
      const newChar = new Character();

      newChar.set('id', newId);
      newChar.set('name', submissionData.name);
      newChar.set('description', submissionData.description);
      newChar.set('imageUrl', imageUrl);
      newChar.set('characterPrompt', submissionData.characterPrompt);
      newChar.set('userProfilePrompt', submissionData.userProfilePrompt);
      newChar.set('storyBackgroundPrompt', submissionData.storyBackgroundPrompt);
      newChar.set('storyStartPrompt', submissionData.storyStartPrompt);
      
      newChar.set('tags', submissionData.tags || []);
      
      if (submitter) {
        newChar.set('author', submitter);
        newChar.set('authorName', submitter.get('username'));
      }

      await newChar.save(null, { useMasterKey: true });
      submission.set('status', 'published');
      await submission.save();
      successCount++;
    } catch (error) {
      console.error(`发布角色失败，Submission ID: ${submission.id}, 错误:`, error);
      failedSubmissions.push(submission.id);
    }
  }
  let resultMessage = `发布完成！成功发布 ${successCount} 个角色。`;
  if (failedSubmissions.length > 0) {
    resultMessage += ` 失败 ${failedSubmissions.length} 个，ID: ${failedSubmissions.join(', ')}。请检查日志。`;
  }
  return resultMessage;
});

AV.Cloud.define('batchAddOfficialCharacters', async (request) => {
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }
  
  const adminUser = request.currentUser;
  if (!adminUser) {
    throw new AV.Cloud.Error('无法获取管理员用户信息。', { code: 401 });
  }
  const adminUsername = adminUser.get('username');

  let charactersData;
  if (Array.isArray(request.params)) {
    charactersData = request.params;
  } else if (request.params && Array.isArray(request.params.charactersData)) {
    charactersData = request.params.charactersData;
  } else {
    throw new AV.Cloud.Error('参数格式无效。请直接粘贴角色数组，或使用 {"charactersData": [...]} 的格式。', { code: 400 });
  }
  if (charactersData.length === 0) {
    return "传入的角色数组为空，未执行任何操作。";
  }
  const charactersToSave = [];
  const Character = AV.Object.extend('Character');
  const existingIds = new Set();
  for (const charData of charactersData) {
    if (typeof charData.id !== 'number') {
      throw new AV.Cloud.Error(`发现一个角色数据缺少有效的数字 "id" 字段: ${JSON.stringify(charData)}`, { code: 400 });
    }
    if (existingIds.has(charData.id)) {
       throw new AV.Cloud.Error(`数据中存在重复的ID: ${charData.id}`, { code: 400 });
    }
    existingIds.add(charData.id);
    const newChar = new Character();
    newChar.set('id', charData.id);
    newChar.set('name', charData.name || '未命名');
    newChar.set('description', charData.description || '');
    newChar.set('imageUrl', charData.imageUrl || '');
    newChar.set('characterPrompt', charData.characterPrompt || '');
    newChar.set('userProfilePrompt', charData.userProfilePrompt || '');
    newChar.set('storyBackgroundPrompt', charData.storyBackgroundPrompt || '');
    newChar.set('storyStartPrompt', charData.storyStartPrompt || '');
    newChar.set('tags', charData.tags || []);
    newChar.set('firstSentence', charData['first sentence'] || charData.description || '');
    newChar.set('sdPrompt', charData.sd_prompt || '');

    newChar.set('author', adminUser); 
    newChar.set('authorName', adminUsername);

    charactersToSave.push(newChar);
  }
  const idQuery = new AV.Query('Character');
  idQuery.containedIn('id', Array.from(existingIds));
  const conflictedChars = await idQuery.find({ useMasterKey: true });
  if (conflictedChars.length > 0) {
      const conflictedIds = conflictedChars.map(c => c.get('id'));
      throw new AV.Cloud.Error(`操作被中断！以下ID已存在于数据库中: ${conflictedIds.join(', ')}`, { code: 409 });
  }
  if (charactersToSave.length > 0) {
    try {
      await AV.Object.saveAll(charactersToSave, { useMasterKey: true });
    } catch (error) {
      console.error('批量保存角色时发生错误:', error);
      throw new AV.Cloud.Error('批量保存失败，请检查日志。', { code: 500 });
    }
  }
  return `操作成功！成功添加了 ${charactersToSave.length} 个官方角色，并自动绑定作者为 "${adminUsername}"。`;
});

AV.Cloud.define('batchDeleteCharacters', async (request) => {
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }
  const { characterIds } = request.params;
  if (!Array.isArray(characterIds) || characterIds.length === 0) {
    throw new AV.Cloud.Error('参数 characterIds 必须是一个包含数字ID的数组。', { code: 400 });
  }
  console.log(`准备删除角色，ID列表: ${characterIds.join(', ')}`);
  const query = new AV.Query('Character');
  query.containedIn('id', characterIds);
  query.limit(1000);
  const charactersToDelete = await query.find({ useMasterKey: true });
  if (charactersToDelete.length === 0) {
    return '没有找到与提供的ID匹配的角色，无需删除。';
  }
  const qiniuKeysToDelete = [];
  const bucketUrl = process.env.QINIU_BUCKET_URL;
  if (!bucketUrl) {
    throw new AV.Cloud.Error('环境变量 QINIU_BUCKET_URL 未设置，无法删除图片。', { code: 500 });
  }
  for (const char of charactersToDelete) {
    const imageUrl = char.get('imageUrl');
    if (imageUrl && imageUrl.startsWith(bucketUrl)) {
      const key = imageUrl.replace(bucketUrl + '/', '');
      qiniuKeysToDelete.push(key);
    }
  }
  if (qiniuKeysToDelete.length > 0) {
    try {
      const accessKey = process.env.QINIU_AK;
      const secretKey = process.env.QINIU_SK;
      const bucket = process.env.QINIU_BUCKET_NAME;
      const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
      const config = new qiniu.conf.Config();
      const bucketManager = new qiniu.rs.BucketManager(mac, config);
      const deleteOperations = qiniuKeysToDelete.map(key => qiniu.rs.deleteOp(bucket, key));
      await new Promise((resolve, reject) => {
        bucketManager.batch(deleteOperations, (err, respBody, respInfo) => {
          if (err) {
            return reject(err);
          }
          if (respInfo.statusCode === 200) {
            const hasError = respBody.some(item => item.code !== 200 && item.code !== 612);
            if (hasError) {
              console.error('七牛云部分文件删除失败:', respBody);
            }
            resolve(respBody);
          } else {
            reject(new Error(`七牛云批量删除请求失败，状态码: ${respInfo.statusCode}, 信息: ${JSON.stringify(respBody)}`));
          }
        });
      });
      console.log(`成功从七牛云删除 ${qiniuKeysToDelete.length} 个图片文件。`);
    } catch (e) {
      console.error('删除七牛云文件时发生严重错误:', e);
      throw new AV.Cloud.Error('删除七牛云图片失败，操作已中断。', { code: 500 });
    }
  }
  try {
    await AV.Object.destroyAll(charactersToDelete, { useMasterKey: true });
    console.log(`成功从 LeanCloud 删除了 ${charactersToDelete.length} 个角色对象。`);
  } catch (error) {
    console.error('删除 LeanCloud 角色数据时发生错误:', error);
    throw new AV.Cloud.Error('删除数据库记录失败。', { code: 500 });
  }
  return `操作成功！删除了 ${charactersToDelete.length} 个角色记录和 ${qiniuKeysToDelete.length} 个关联图片。`;
});

AV.Cloud.define('migrateAllCharactersToOwner', async (request) => {
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }
  const ownerId = '68651ac4ce7fc86faf9b4eb5';
  const ownerName = '雨息';
  const ownerPointer = AV.Object.createWithoutData('_User', ownerId);
  let totalUpdatedCount = 0;
  let skip = 0;
  const limit = 200;
  let hasMore = true;
  console.log(`开始迁移任务：将所有角色作者更改为 ${ownerName} (ID: ${ownerId})`);
  while (hasMore) {
    const query = new AV.Query('Character');
    query.limit(limit);
    query.skip(skip);
    const charactersToUpdate = await query.find({ useMasterKey: true });
    if (charactersToUpdate.length > 0) {
      for (const char of charactersToUpdate) {
        char.set('author', ownerPointer);
        char.set('authorName', ownerName);
      }
      try {
        await AV.Object.saveAll(charactersToUpdate, { useMasterKey: true });
        totalUpdatedCount += charactersToUpdate.length;
        skip += charactersToUpdate.length;
        console.log(`成功处理 ${charactersToUpdate.length} 个角色，当前总计: ${totalUpdatedCount}`);
      } catch (error) {
        console.error(`在处理批次时发生错误 (skip=${skip}):`, error);
        throw new AV.Cloud.Error(`批量保存失败，请检查日志。已处理 ${totalUpdatedCount} 个。`, { code: 500 });
      }
    } else {
      hasMore = false;
    }
  }
  const resultMessage = `迁移任务完成！总共更新了 ${totalUpdatedCount} 个角色的作者信息为 "${ownerName}"。`;
  console.log(resultMessage);
  return resultMessage;
});

// =================================================================
// == 数据维护云函数 (管理员专用)
// =================================================================

/**
 * 批量更新 Character 表中 imageUrl 字段的域名。
 * 这是一个管理员专用函数，用于数据迁移或更换 CDN 域名。
 * @param {string} oldDomain - 需要被替换的旧域名，例如 "http://old.domain.com"
 * @param {string} newDomain - 用来替换的新域名，例如 "http://new.domain.com"
 */
AV.Cloud.define('batchUpdateCharacterImageDomains', async (request) => {
  // 1. 安全校验：确保只有管理员可以执行此操作
  const userRoles = await getUserRoles(request);
  if (!userRoles.includes('Admin')) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }

  // 2. 参数校验
  const { oldDomain, newDomain } = request.params;
  if (!oldDomain || !newDomain || typeof oldDomain !== 'string' || typeof newDomain !== 'string') {
    throw new AV.Cloud.Error('参数无效，必须提供 "oldDomain" 和 "newDomain" 字符串。', { code: 400 });
  }
  
  console.log(`开始执行域名替换任务：将 "${oldDomain}" 替换为 "${newDomain}"`);

  // 3. 分批处理逻辑
  let totalProcessedCount = 0;
  let totalUpdatedCount = 0;
  let skip = 0;
  const limit = 200; // 每次处理200条，防止超时
  let hasMore = true;

  while (hasMore) {
    const query = new AV.Query('Character');
    // 只查询 imageUrl 以旧域名开头的记录
    query.startsWith('imageUrl', oldDomain);
    query.limit(limit);
    query.skip(skip);

    const charactersToUpdate = await query.find({ useMasterKey: true });

    if (charactersToUpdate.length > 0) {
      const charactersToSave = [];
      for (const char of charactersToUpdate) {
        const currentUrl = char.get('imageUrl');
        // 替换域名并创建新的 URL
        const newUrl = currentUrl.replace(oldDomain, newDomain);
        char.set('imageUrl', newUrl);
        charactersToSave.push(char);
      }

      if (charactersToSave.length > 0) {
        await AV.Object.saveAll(charactersToSave, { useMasterKey: true });
        totalUpdatedCount += charactersToSave.length;
      }
      
      totalProcessedCount += charactersToUpdate.length;
      console.log(`已处理 ${totalProcessedCount} 条记录，其中更新了 ${charactersToSave.length} 条。`);
      
      // 如果返回的数量等于限制数量，说明可能还有更多数据
      if (charactersToUpdate.length < limit) {
        hasMore = false;
      } else {
        // 准备下一批 (LeanCloud 的 skip 是基于总数的，所以这里不需要增加 skip)
      }
    } else {
      hasMore = false;
    }
  }

  const resultMessage = `任务完成！总共检查了 ${totalProcessedCount} 个匹配的角色，其中 ${totalUpdatedCount} 个角色的域名已被成功更新。`;
  console.log(resultMessage);
  return resultMessage;
});

module.exports = AV.Cloud;
