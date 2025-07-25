// cloud.js (已修复所有 JavaScript 语法错误)

'use strict';
const AV = require('leanengine');
const qiniu = require('qiniu');

// --- 辅助函数：检查用户是否为管理员 ---
const isAdmin = async (user) => {
  if (!user) return false;
  const query = new AV.Query(AV.Role);
  query.equalTo('name', 'Admin');
  query.equalTo('users', user);
  const count = await query.count({ useMasterKey: true });
  return count > 0;
};

AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});

// --- 用户与个人资料 ---
AV.Cloud.define('updateUserProfile', async (request) => {
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
    console.error(`更新用户 ${user.id} 资料失败:`, error); // 修复
    if (error.code === 202) {
         throw new AV.Cloud.Error('该昵称已被使用。', { code: 409 });
    }
    throw new AV.Cloud.Error('更新失败，请稍后再试。', { code: 500 });
  }
});

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
        console.log(`准备删除旧头像，Key: ${oldKey}`); // 修复
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
                   reject(new Error(`删除失败，状态码: ${respInfo.statusCode}, 信息: ${JSON.stringify(respBody)}`)); // 修复
                } else {
                   console.log(`旧文件(Key: ${oldKey})在七牛云不存在，无需删除。`); // 修复
                   resolve(respBody);
                }
              }
            }
          });
        });
        console.log(`成功删除旧头像: ${oldKey}`); // 修复
      }
    } catch (e) {
      console.error(`删除旧头像(URL: ${oldAvatarUrl})时发生错误:`, e); // 修复
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
    console.log(`用户 ${user.id} 已关注 ${targetUserId}，无需重复操作。`); // 修复
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
    console.log(`用户 ${user.id} 未关注 ${targetUserId}，无需取消。`); // 修复
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
    console.warn(`未在 Character 表中找到 id 为 ${characterId} 的角色，将只更新用户喜欢列表。`); // 修复
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
    console.error(`原子性保存用户和角色失败:`, error); // 修复
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
    console.warn(`尝试为不存在的角色 (id: ${characterId}) 增加聊天计数。`); // 修复
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

AV.Cloud.define('getUserPublicProfile', async (request) => {
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
    stats: stats,
    isFollowing: isFollowing,
  };
});

AV.Cloud.define('getUserCreations', async (request) => {
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

// --- 管理员批量操作函数 ---
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
      throw new AV.Cloud.Error(`发现一个角色数据缺少有效的数字 "id" 字段: ${JSON.stringify(charData)}`, { code: 400 }); // 修复
    }
    if (existingIds.has(charData.id)) {
       throw new AV.Cloud.Error(`数据中存在重复的ID: ${charData.id}`, { code: 400 }); // 修复
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
      throw new AV.Cloud.Error(`操作被中断！以下ID已存在于数据库中: ${conflictedIds.join(', ')}`, { code: 409 }); // 修复
  }

  if (charactersToSave.length > 0) {
    try {
      await AV.Object.saveAll(charactersToSave, { useMasterKey: true });
    } catch (error) {
      console.error('批量保存角色时发生错误:', error);
      throw new AV.Cloud.Error('批量保存失败，请检查日志。', { code: 500 });
    }
  }

  return `操作成功！成功添加了 ${charactersToSave.length} 个官方角色。`; // 修复
});

AV.Cloud.define('batchDeleteCharacters', async (request) => {
  if (!(await isAdmin(request.currentUser))) {
    throw new AV.Cloud.Error('权限不足，仅限管理员操作。', { code: 403 });
  }

  const { characterIds } = request.params;
  if (!Array.isArray(characterIds) || characterIds.length === 0) {
    throw new AV.Cloud.Error('参数 characterIds 必须是一个包含数字ID的数组。', { code: 400 });
  }

  console.log(`准备删除角色，ID列表: ${characterIds.join(', ')}`); // 修复

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
    console.log(`成功从 LeanCloud 删除了 ${charactersToDelete.length} 个角色对象。`); // 修复
  } catch (error) {
    console.error('删除 LeanCloud 角色数据时发生错误:', error);
    throw new AV.Cloud.Error('删除数据库记录失败。', { code: 500 });
  }

  return `操作成功！删除了 ${charactersToDelete.length} 个角色记录和 ${qiniuKeysToDelete.length} 个关联图片。`; // 修复
});

// --- 数据迁移函数 ---
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

  console.log(`开始迁移任务：将所有角色作者更改为 ${ownerName} (ID: ${ownerId})`); // 修复

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

module.exports = AV.Cloud;
