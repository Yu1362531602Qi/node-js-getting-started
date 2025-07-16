// cloud.js (包含“状态同步”功能的最终完整版)

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

// --- 函数 3: 获取七牛云上传凭证 (您的原始函数，保留) ---
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

// --- 函数 4: 一键发布已批准的角色 (您的原始函数，保留) ---
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


// --- vvv 函数 5: (新增) 批量获取提交记录的最新状态 vvv ---
/**
 * [核心功能] 批量获取提交记录的最新状态
 * 接收一个包含本地角色 ID 的数组，返回这些 ID 在云端的最新状态。
 */
AV.Cloud.define('getSubmissionStatuses', async (request) => {
  // 1. 检查用户是否登录
  const user = request.currentUser;
  if (!user) {
    throw new AV.Cloud.Error('用户未登录，禁止操作。', { code: 401 });
  }

  // 2. 从请求参数中获取本地角色 ID 列表
  const { localIds } = request.params;
  if (!Array.isArray(localIds) || localIds.length === 0) {
    return {}; // 如果没有提供 ID，返回空对象
  }

  // 3. 构建查询
  const submissionQuery = new AV.Query('CharacterSubmissions');
  // 查询条件：提交者是当前用户，并且 localId 在传入的数组中
  submissionQuery.equalTo('submitter', user);
  submissionQuery.containedIn('localId', localIds); 
  // 我们只需要 localId 和 status 两个字段，提高查询效率
  submissionQuery.select(['localId', 'status']);
  submissionQuery.limit(1000); // 最多查询1000条

  const submissions = await submissionQuery.find();

  // 4. 将查询结果处理成一个 "localId: status" 的映射
  const statuses = {};
  for (const submission of submissions) {
    statuses[submission.get('localId')] = submission.get('status');
  }

  return statuses;
});
// --- ^^^ 以上是所有需要添加的代码 ^^^ ---
