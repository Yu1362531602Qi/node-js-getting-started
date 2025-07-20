// cloud.js (完整替换)

'use strict';
const AV = require('leanengine');
const qiniu = require('qiniu');

AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 用户与个人资料 ---

// --- vvv 核心修改 1：新增 updateUserProfile 云函数 vvv ---
AV.Cloud.define('updateUserProfile', async (request) => {
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  const { username, bio } = request.params;

  // 验证并设置昵称
  if (username !== undefined) {
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2 || trimmedUsername.length > 15) {
      throw new AV.Cloud.Error('昵称长度必须在 2 到 15 个字符之间。', { code: 400 });
    }
    // 检查昵称是否已被其他用户占用
    if (trimmedUsername !== user.get('username')) {
        const query = new AV.Query('_User');
        query.equalTo('username', trimmedUsername);
        const existingUser = await query.first();
        if (existingUser) {
            throw new AV.Cloud.Error('该昵称已被使用。', { code: 409 }); // 409 Conflict
        }
    }
    user.set('username', trimmedUsername);
  }

  // 验证并设置个性签名
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
    if (error.code === 202) { // LeanCloud 内置的用户名/邮箱重复错误码
         throw new AV.Cloud.Error('该昵称已被使用。', { code: 409 });
    }
    throw new AV.Cloud.Error('更新失败，请稍后再试。', { code: 500 });
  }
});
// --- ^^^ 核心修改 1 ^^^ ---

AV.Cloud.define('getQiniuUserAvatarUploadToken', async (request) => {
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
  const followQuery = new AV.Query('Follow');
  followQuery.equalTo('user', user);
  followQuery.equalTo('followed', AV.Object.createWithoutData('_User', targetUserId));
  const existingFollow = await followQuery.first();
  if (existingFollow) {
    console.log(`用户 ${user.id} 已关注 ${targetUserId}，无需重复操作。`);
    return { success: true, message: '已关注' };
  }
  const Follow = AV.Object.extend('Follow');
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
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }
  const { targetUserId } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const followQuery = new AV.Query('Follow');
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
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const targetUser = AV.Object.createWithoutData('_User', targetUserId);
  const query = new AV.Query('Follow');
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
  const { targetUserId, page = 1, limit = 20 } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供 targetUserId 参数。', { code: 400 });
  }
  const targetUser = AV.Object.createWithoutData('_User', targetUserId);
  const query = new AV.Query('Follow');
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


// --- 管理员后台功能 ---

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

// --- vvv 核心修改 2：让 getUserPublicProfile 返回 bio 字段 vvv ---
AV.Cloud.define('getUserPublicProfile', async (request) => {
  const { userId } = request.params;
  const currentUser = request.currentUser;
  if (!userId) {
    throw new AV.Cloud.Error('必须提供 userId 参数。', { code: 400 });
  }
  const userQuery = new AV.Query('_User');
  // 在这里添加 'bio'
  userQuery.select(['username', 'avatarUrl', 'objectId', 'followingCount', 'followersCount', 'bio']);
  const user = await userQuery.get(userId, { useMasterKey: true });
  if (!user) {
    throw new AV.Cloud.Error('用户不存在。', { code: 404 });
  }
  const creationsQuery = new AV.Query('CharacterSubmissions');
  creationsQuery.equalTo('submitter', AV.Object.createWithoutData('_User', userId));
  creationsQuery.equalTo('status', 'published');
  creationsQuery.descending('createdAt');
  creationsQuery.limit(50);
  const submissions = await creationsQuery.find();
  const creations = submissions.map(sub => {
    const charData = sub.get('characterData');
    return {
      id: sub.get('localId'), 
      name: charData.name,
      description: charData.description,
      imageUrl: sub.get('imageUrl'),
      characterPrompt: charData.characterPrompt,
      userProfilePrompt: charData.userProfilePrompt,
      storyBackgroundPrompt: charData.storyBackgroundPrompt,
      storyStartPrompt: charData.storyStartPrompt,
      tags: charData.tags || [],
    };
  });
  const stats = {
    following: user.get('followingCount') || 0,
    followers: user.get('followersCount') || 0,
    likesReceived: 0,
  };
  let isFollowing = false;
  if (currentUser && currentUser.id !== userId) {
    const followQuery = new AV.Query('Follow');
    followQuery.equalTo('user', currentUser);
    followQuery.equalTo('followed', user);
    const followRecord = await followQuery.first();
    if (followRecord) {
      isFollowing = true;
    }
  }
  return {
    user: user.toJSON(),
    creations: creations,
    stats: stats,
    isFollowing: isFollowing,
  };
});
// --- ^^^ 核心修改 2 ^^^ ---
