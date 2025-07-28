// cloud.js (V4.0 - API 代理与密钥云端化)

'use strict';
const AV = require('leanengine');
const qiniu = require('qiniu');
const crypto =require('crypto');
const axios = require('axios'); // 核心新增：用于发送网络请求

// =================================================================
// == 安全校验核心模块 (无变动)
// =================================================================

const validateSessionAuth = (request) => {
  const sessionAuthToken = request.expressReq.get('X-Session-Auth-Token');
  if (!sessionAuthToken) {
    throw new AV.Cloud.Error('无效的客户端，禁止操作。', { code: 403 });
  }
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

const isAdmin = async (user) => {
  if (!user) return false;
  const query = new AV.Query(AV.Role);
  query.equalTo('name', 'Admin');
  query.equalTo('users', user);
  const count = await query.count({ useMasterKey: true });
  return count > 0;
};

const getUserRoles = async (user) => {
    if (!user) return ['User'];
    const roleQuery = new AV.Query(AV.Role);
    roleQuery.equalTo('users', user);
    const roles = await roleQuery.find({ useMasterKey: true });
    const roleNames = roles.map(role => role.get('name'));
    if (roleNames.length === 0 || !roleNames.includes('User')) {
        roleNames.push('User');
    }
    return roleNames;
};

// =================================================================
// == API 调用许可与代理模块 (核心重构)
// =================================================================

// --- 辅助函数：获取并检查 API 密钥 ---
function getApiKey(serviceProvider) {
    const keyMap = {
        'deepseek': process.env.DEEPSEEK_API_KEY,
        'siliconflow': process.env.SILICONFLOW_API_KEY,
        'gemini': process.env.GEMINI_API_KEY,
        'minimax': process.env.MINIMAX_API_KEY,
        'minimax_group': process.env.MINIMAX_GROUP_ID,
    };
    const apiKey = keyMap[serviceProvider];
    if (!apiKey) {
        console.error(`FATAL: 环境变量 ${serviceProvider.toUpperCase()}_API_KEY 未设置！`);
        throw new AV.Cloud.Error(`服务器内部配置错误 (${serviceProvider})。`, { code: 500 });
    }
    return apiKey;
}

// --- 辅助函数：检查并增加用量 ---
async function checkAndIncrementUsage(user, usageType, permissions) {
    const today = new Date().toISOString().slice(0, 10);
    const lastCallDate = user.get('lastCallDate');
    const usageCountField = `${usageType}CallCount`;
    let currentUsage = user.get(usageCountField) || 0;

    if (lastCallDate !== today) {
        user.set('lastCallDate', today);
        user.set('llmCallCount', 0);
        user.set('ttsCallCount', 0);
        currentUsage = 0;
    }

    const limitField = `${usageType}Limit`;
    const dailyLimit = Math.max(...permissions.map(p => p.get(limitField) || 0));

    if (currentUsage >= dailyLimit) {
        throw new AV.Cloud.Error(`您今日的${usageType === 'llm' ? '语言模型' : '语音'}调用次数已达上限 (${dailyLimit}次)。`, { code: 429 });
    }

    user.increment(usageCountField, 1);
    // 注意：这里不再立即 save，而是在请求成功后再保存，避免网络失败时也扣费
}

// --- 统一的权限检查函数 (现在返回更丰富的信息) ---
async function getApiPermission(request, usageType) {
    const user = request.currentUser;
    if (!user) {
        throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
    }

    if (await isAdmin(user)) {
        return { canCall: true, historyLimit: -1, userToUpdate: null };
    }

    const userRoles = await getUserRoles(user);
    const permissionQuery = new AV.Query('RolePermission');
    permissionQuery.containedIn('roleName', userRoles);
    const permissions = await permissionQuery.find({ useMasterKey: true });

    if (permissions.length === 0) {
        throw new AV.Cloud.Error('服务器权限配置错误，请联系管理员。', { code: 500 });
    }

    const historyLimit = Math.max(...permissions.map(p => p.get('historyLimit') ?? 15));
    
    // 检查用量，如果超限会抛出异常
    await checkAndIncrementUsage(user, usageType, permissions);

    return { canCall: true, historyLimit, userToUpdate: user };
}


// --- vvv 核心新增：语言模型代理云函数 vvv ---
AV.Cloud.define('proxyLlmRequest', async (request) => {
    validateSessionAuth(request);

    // 1. 权限和用量检查
    const permission = await getApiPermission(request, 'llm');
    
    // 2. 从客户端获取参数
    const { serviceProvider, modelName, messages } = request.params;
    if (!serviceProvider || !modelName || !messages) {
        throw new AV.Cloud.Error('缺少必要参数 (serviceProvider, modelName, messages)。', { code: 400 });
    }

    // 3. 根据服务商选择 API Key 和 URL
    const apiKey = getApiKey(serviceProvider);
    const apiEndpoints = {
        'deepseek': 'https://api.deepseek.com/chat/completions',
        'siliconflow': 'https://api.siliconflow.cn/v1/chat/completions',
        'gemini': 'https://api.ssopen.top/v1/chat/completions',
    };
    const apiUrl = apiEndpoints[serviceProvider];
    if (!apiUrl) {
        throw new AV.Cloud.Error(`不支持的服务提供商: ${serviceProvider}`, { code: 400 });
    }

    // 4. 构造请求体
    const requestBody = {
        model: modelName,
        messages: messages,
        stream: true, // 强制开启流式响应
        temperature: 1.2, // 可以根据需要调整或从客户端传递
    };

    try {
        // 5. 发起流式请求
        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            },
            responseType: 'stream' // 关键：告诉 axios 我们需要一个流
        });

        // 6. 将第三方 API 的流直接 pipe 到客户端响应中
        // 这是实现服务器流式代理的核心
        request.res.setHeader('Content-Type', 'application/octet-stream');
        response.data.pipe(request.res);

        // 7. 请求成功后，保存用户用量计数
        if (permission.userToUpdate) {
            await permission.userToUpdate.save(null, { useMasterKey: true });
            console.log(`用户 ${permission.userToUpdate.id} 的 llmCallCount 已更新。`);
        }

    } catch (error) {
        console.error(`代理请求到 ${serviceProvider} 失败:`, error.response ? error.response.data : error.message);
        // 如果代理请求失败，不应该扣除用户次数，所以这里不需要回滚操作
        throw new AV.Cloud.Error(`请求 ${serviceProvider} 服务失败。`, { code: 502 }); // 502 Bad Gateway
    }
});
// --- ^^^ 核心新增 ^^^ ---


// --- vvv 核心新增：TTS 代理云函数 vvv ---
AV.Cloud.define('proxyTtsRequest', async (request) => {
    validateSessionAuth(request);

    // 1. 权限和用量检查
    const permission = await getApiPermission(request, 'tts');

    // 2. 从客户端获取参数
    const { voiceType, systemVoiceId, customVoiceId, customApiKey, text, emotion } = request.params;
    if (!text || !voiceType) {
        throw new AV.Cloud.Error('缺少必要参数 (text, voiceType)。', { code: 400 });
    }

    // 3. 确定使用的 API Key 和 Voice ID
    let apiKey, voiceId;
    if (voiceType === 'custom') {
        if (!customApiKey || !customVoiceId) {
            throw new AV.Cloud.Error('自定义语音模式下，缺少 customApiKey 或 customVoiceId。', { code: 400 });
        }
        apiKey = customApiKey;
        voiceId = customVoiceId;
    } else { // system
        apiKey = getApiKey('minimax');
        voiceId = systemVoiceId || 'female-yujie'; // 默认音色
    }
    const groupId = getApiKey('minimax_group');

    // 4. 构造请求体
    const emotionVoiceSettings = {
        'angry': {'speed': 1.1, 'vol': 1.2, 'pitch': -1},
        'sad': {'speed': 0.9, 'vol': 0.9, 'pitch': -1},
        'happy': {'speed': 1.1, 'vol': 1.1, 'pitch': 1},
        'fearful': {'speed': 1.15, 'vol': 0.9, 'pitch': 1},
        'surprised': {'speed': 1.0, 'vol': 1.0, 'pitch': 1},
        'neutral': {'speed': 1.0, 'vol': 1.0, 'pitch': 0},
    };
    const voiceParams = emotionVoiceSettings[emotion] || emotionVoiceSettings['neutral'];
    
    const requestBody = {
        model: 'speech-02-hd',
        text: text,
        voice_setting: {
            voice_id: voiceId,
            ...voiceParams
        },
        audio_setting: {
            sample_rate: 24000,
            bitrate: 128000,
            format: "mp3"
        }
    };

    try {
        // 5. 发起非流式请求
        const response = await axios.post(
            `https://api.minimaxi.com/v1/t2a_v2?GroupId=${groupId}`,
            requestBody,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        // 6. 请求成功后，保存用户用量计数
        if (permission.userToUpdate) {
            await permission.userToUpdate.save(null, { useMasterKey: true });
            console.log(`用户 ${permission.userToUpdate.id} 的 ttsCallCount 已更新。`);
        }

        // 7. 将 MiniMax 的完整响应返回给客户端
        return response.data;

    } catch (error) {
        console.error('代理请求到 MiniMax 失败:', error.response ? error.response.data : error.message);
        throw new AV.Cloud.Error('请求语音合成服务失败。', { code: 502 });
    }
});
// --- ^^^ 核心新增 ^^^ ---


// =================================================================
// == 现有业务云函数 (大部分无变动)
// =================================================================

// --- vvv 核心移除：requestApiCallPermission 函数已被新的代理函数取代 vvv ---
// 旧的 requestApiCallPermission 函数已删除，其逻辑被整合进了新的代理函数中
// --- ^^^ 核心移除 ^^^ ---

AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});

// ... (从这里开始，下面的所有云函数 'updateUserProfile', 'getQiniuUserAvatarUploadToken', 'saveUserAvatarUrl', 'followUser', 'unfollowUser', 'getFollowers', 'getFollowing', 'generateNewLocalCharacterId', 'toggleLikeCharacter', 'incrementChatCount', 'getQiniuUploadToken', 'getSubmissionStatuses', 'searchPublicContent', 'getUserPublicProfile', 'getUserCreations' 以及所有管理员函数和 afterSave Hook 都保持原样，无需修改)
// ... (此处省略未修改的函数代码，请保留您原来的代码)
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
  const followQuery = new AV.Query('UserFollow'); // 核心修改
  followQuery.equalTo('user', user);
  followQuery.equalTo('followed', AV.Object.createWithoutData('_User', targetUserId));
  const existingFollow = await followQuery.first();
  if (existingFollow) {
    console.log(`用户 ${user.id} 已关注 ${targetUserId}，无需重复操作。`);
    return { success: true, message: '已关注' };
  }
  const Follow = AV.Object.extend('UserFollow'); // 核心修改
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
  const followQuery = new AV.Query('UserFollow'); // 核心修改
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
  const query = new AV.Query('UserFollow'); // 核心修改
  query.equalTo('followed', targetUser);
  query.include('user');
  query.select('user.username', 'user.avatarUrl', 'user.objectId');
  query.skip((page - 1) * limit);
  query.limit(limit);
  query.descending('createdAt');
  const results = await query.find();
  return results.map(follow => follow.get('user'));
});

AV.Cloud.define('getFollowing', async (request) => {
  validateSessionAuth(request);
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const targetUser = AV.Object.createWithoutData('_User', targetUserId);
  const query = new AV.Query('UserFollow'); // 核心修改
  query.equalTo('user', targetUser);
  query.include('followed');
  query.select('followed.username', 'followed.avatarUrl', 'followed.objectId');
  query.skip((page - 1) * limit);
  query.limit(limit);
  query.descending('createdAt');
  const results = await query.find();
  return results.map(follow => follow.get('followed'));
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
    const followQuery = new AV.Query('UserFollow'); // 核心修改
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


// =================================================================
// == 管理员后台功能
// =================================================================

AV.Cloud.define('publishApprovedCharacters', async (request) => {
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
  if (!(await isAdmin(request.currentUser))) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }
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
  return `操作成功！成功添加了 ${charactersToSave.length} 个官方角色。`;
});

AV.Cloud.define('batchDeleteCharacters', async (request) => {
  if (!(await isAdmin(request.currentUser))) {
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
  if (!(await isAdmin(request.currentUser))) {
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
// == Cloud Hook - 新用户自动加入角色 (调试增强版)
// =================================================================

AV.Cloud.afterSave('_User', async (request) => {
  const newUser = request.object;

  if (newUser.isNew()) {
    console.log(`[DEBUG] afterSave Hook triggered for new user, objectId: ${newUser.id}`);

    const roleQuery = new AV.Query(AV.Role);
    roleQuery.equalTo('name', 'User');
    
    try {
      console.log('[DEBUG] Step 1: Querying for role with name "User"...');
      const userRole = await roleQuery.first({ useMasterKey: true });

      if (userRole) {
        console.log(`[DEBUG] Step 2: Found role "User" with objectId: ${userRole.id}`);
        const relation = userRole.relation('users');
        
        console.log(`[DEBUG] Step 3: Adding new user ${newUser.id} to the role relation...`);
        relation.add(newUser);
        
        console.log('[DEBUG] Step 4: Saving the role object...');
        await userRole.save(null, { useMasterKey: true });
        
        console.log(`[SUCCESS] Successfully added new user ${newUser.id} to the 'User' role.`);
      } else {
        console.error('FATAL: The "User" role was not found. Could not assign role to new user.');
        
        const allRolesQuery = new AV.Query(AV.Role);
        const allRoles = await allRolesQuery.find({ useMasterKey: true });
        const allRoleNames = allRoles.map(r => r.get('name'));
        console.error(`[DEBUG] All existing roles in _Role table are: [${allRoleNames.join(', ')}]`);
      }
    } catch (error) {
      console.error(`[ERROR] An error occurred while adding user to role in afterSave hook: ${error}`);
    }
  }
});

module.exports = AV.Cloud;
