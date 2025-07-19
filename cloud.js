// lib/cloud.js

// cloud.js (最终版 - 包含用户专属ID生成器和增强版全局搜索功能)

'use strict';
// 引入 LeanCloud SDK
const AV = require('leanengine');
// 引入七牛云 SDK
const qiniu = require('qiniu');

/**
 * 一个简单的云代码方法 (模板自带，保留)
 */
AV.Cloud.define('hello', function(request) {
  return 'Hello world!';
});


// --- 用户与个人资料 ---

/**
 * 获取用户头像上传到七牛云的凭证和文件Key
 */
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

/**
 * 保存用户头像的URL，并自动删除旧头像
 */
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


// --- vvv 核心新增：关注系统相关云函数 vvv ---

/**
 * 关注或取消关注一个用户
 * @param {string} userId - 要关注或取关的用户的 objectId
 * @returns {object} - { status: 'followed' | 'unfollowed' }
 */
AV.Cloud.define('toggleFollow', async (request) => {
  const currentUser = request.currentUser;
  if (!currentUser) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  const { userId: targetUserId } = request.params;
  if (!targetUserId) {
    throw new AV.Cloud.Error('必须提供目标用户的 userId。', { code: 400 });
  }
  
  if (currentUser.id === targetUserId) {
    throw new AV.Cloud.Error('不能关注自己。', { code: 400 });
  }

  const follower = currentUser;
  const following = AV.Object.createWithoutData('_User', targetUserId);

  const query = new AV.Query('Follow');
  query.equalTo('follower', follower);
  query.equalTo('following', following);
  const relation = await query.first();

  if (relation) {
    // 已关注，执行取关
    await relation.destroy({ useMasterKey: true });
    return { status: 'unfollowed' };
  } else {
    // 未关注，执行关注
    const newFollow = new AV.Object('Follow');
    newFollow.set('follower', follower);
    newFollow.set('following', following);
    
    // 设置ACL，保证只有关注者自己能删除这个关系
    const acl = new AV.ACL();
    acl.setReadAccess(currentUser, true);
    acl.setWriteAccess(currentUser, true);
    acl.setPublicReadAccess(true); // 允许任何人读取，以便查询粉丝列表等
    newFollow.setACL(acl);

    await newFollow.save(null, { useMasterKey: true });
    return { status: 'followed' };
  }
});

/**
 * 在 Follow 关系创建后，更新双方的计数器
 */
AV.Cloud.afterSave('Follow', async (request) => {
  const follower = request.object.get('follower');
  const following = request.object.get('following');

  // 使用 MasterKey 来无视权限更新用户数据
  await follower.increment('followingCount', 1).save(null, { useMasterKey: true });
  await following.increment('followersCount', 1).save(null, { useMasterKey: true });
  
  console.log(`User ${follower.id} followed ${following.id}. Counts updated.`);
});

/**
 * 在 Follow 关系删除后，更新双方的计数器
 */
AV.Cloud.afterDelete('Follow', async (request) => {
  const follower = request.object.get('follower');
  const following = request.object.get('following');

  // 使用 MasterKey 来无视权限更新用户数据
  await follower.increment('followingCount', -1).save(null, { useMasterKey: true });
  await following.increment('followersCount', -1).save(null, { useMasterKey: true });

  console.log(`User ${follower.id} unfollowed ${following.id}. Counts updated.`);
});

// --- ^^^ 核心新增 ^^^ ---


// --- 角色与创作管理 ---

/**
 * 为当前用户生成一个永不重复的、用于本地创作的ID
 * @returns {number} 一个新的、唯一的负整数ID
 */
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

/**
 * 切换用户对某个角色的喜欢状态
 */
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

/**
 * 获取角色图片上传到七牛云的凭证
 */
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

/**
 * 获取用户提交的角色的审核状态
 */
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

/**
 * 全局搜索功能，可同时搜索角色、用户和标签
 * @param {string} searchText - 用户输入的搜索关键词
 * @returns {object} 包含 'characters' 和 'users' 两个数组的搜索结果
 */
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

/**
 * [管理员] 发布所有已批准的角色
 */
AV.Cloud.define('publishApprovedCharacters', async (request) => {
  const submissionQuery = new AV.Query('CharacterSubmissions');
  submissionQuery.equalTo('status', 'approved');
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

/**
 * [核心修改] 获取指定用户的公开主页信息 (增强版)
 * @param {string} userId - 要查询的用户的 objectId
 * @returns {object} 包含用户公开信息、统计数据和已发布作品列表的对象
 */
AV.Cloud.define('getUserPublicProfile', async (request) => {
  const { userId } = request.params;
  const currentUser = request.currentUser; // 获取当前登录用户

  if (!userId) {
    throw new AV.Cloud.Error('必须提供 userId 参数。', { code: 400 });
  }

  // 1. 查询用户基本信息
  const userQuery = new AV.Query('_User');
  // --- vvv 核心修改: 同时查询计数器字段 vvv ---
  userQuery.select(['username', 'avatarUrl', 'objectId', 'followingCount', 'followersCount']);
  // --- ^^^ 核心修改 ^^^ ---
  const user = await userQuery.get(userId);

  if (!user) {
    throw new AV.Cloud.Error('用户不存在。', { code: 404 });
  }

  // --- vvv 核心新增: 查询当前登录用户是否关注了该主页用户 vvv ---
  let isFollowing = false;
  if (currentUser && currentUser.id !== userId) {
    const followQuery = new AV.Query('Follow');
    followQuery.equalTo('follower', currentUser);
    followQuery.equalTo('following', user);
    const followRelation = await followQuery.first();
    if (followRelation) {
      isFollowing = true;
    }
  }
  // --- ^^^ 核心新增 ^^^ ---

  // 2. 查询该用户已发布的作品
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

  // 3. 组合并返回所有数据
  const userJSON = user.toJSON();
  // --- vvv 核心修改: 将 isFollowing 状态和获赞数(占位)加入返回结果 vvv ---
  return {
    user: userJSON,
    creations: creations,
    stats: {
      following: userJSON.followingCount || 0,
      followers: userJSON.followersCount || 0,
      likesReceived: 0, // TODO: 获赞数也需要单独统计
    },
    isFollowing: isFollowing, // 将关注状态返回给客户端
  };
  // --- ^^^ 核心修改 ^^^ ---
});
