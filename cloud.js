// cloud.js (版本 2 - 包含用户头像上传和状态同步功能)

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


// --- 用户头像管理 ---

/**
 * [核心新增] 获取用户头像上传到七牛云的凭证和文件Key
 * 返回一个上传令牌(token)和一个预生成的文件路径(key)
 */
AV.Cloud.define('getQiniuUserAvatarUploadToken', async (request) => {
  // 1. 检查用户登录状态
  if (!request.currentUser) {
    throw new AV.Cloud.Error('用户未登录，禁止获取上传凭证。', { code: 401 });
  }
  const userId = request.currentUser.id;

  // 2. 从环境变量读取七牛云配置
  const accessKey = process.env.QINIU_AK;
  const secretKey = process.env.QINIU_SK;
  const bucket = process.env.QINIU_BUCKET_NAME;

  if (!accessKey || !secretKey || !bucket) {
    console.error('七牛云环境变量未完全设置 (QINIU_AK, QINIU_SK, QINIU_BUCKET_NAME)');
    throw new AV.Cloud.Error('服务器配置错误，无法生成上传凭证。', { code: 500 });
  }

  // 3. 生成一个唯一的文件名 (key)
  // 格式: user_avatars/{用户ID}/{时间戳}.jpg
  // 这样做可以避免文件重名，也便于管理
  const key = `user_avatars/${userId}/${Date.now()}.jpg`;

  // 4. 创建上传策略，指定 bucket 和 key
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const options = {
    scope: `${bucket}:${key}`, // 锁定上传的文件名
    expires: 3600, // 凭证有效期1小时
  };
  const putPolicy = new qiniu.rs.PutPolicy(options);
  const uploadToken = putPolicy.uploadToken(mac);

  // 5. 返回凭证和 key 给客户端
  if (uploadToken) {
    return { token: uploadToken, key: key };
  } else {
    throw new AV.Cloud.Error('生成上传凭证失败。', { code: 500 });
  }
});

/**
 * [核心新增] 保存用户头像的URL
 * 客户端在上传成功后，调用此函数将文件key传回，由后端拼接并保存最终URL
 */
AV.Cloud.define('saveUserAvatarUrl', async (request) => {
  // 1. 检查用户登录状态
  const currentUser = request.currentUser;
  if (!currentUser) {
    throw new AV.Cloud.Error('用户未登录，无法更新头像。', { code: 401 });
  }

  // 2. 获取客户端传回的文件 key
  const { key } = request.params;
  if (!key) {
    throw new AV.Cloud.Error('缺少 key 参数。', { code: 400 });
  }

  // 3. 从环境变量读取七牛云的访问域名
  const bucketUrl = process.env.QINIU_BUCKET_URL;
  if (!bucketUrl) {
      console.error('七牛云环境变量 QINIU_BUCKET_URL 未设置');
      throw new AV.Cloud.Error('服务器配置错误，无法生成头像URL。', { code: 500 });
  }

  // 4. 拼接最终的图片URL
  const avatarUrl = `${bucketUrl}/${key}`;

  // 5. 将URL保存到 _User 表的 avatarUrl 字段
  currentUser.set('avatarUrl', avatarUrl);
  await currentUser.save(null, { useMasterKey: true });

  // 6. 返回成功信息和新的URL
  return { success: true, avatarUrl: avatarUrl };
});


// --- 角色和提交管理 (保留原有功能) ---

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
