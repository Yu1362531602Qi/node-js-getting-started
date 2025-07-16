// cloud.js (包含“一键发布”功能的最终完整版)

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


// --- vvv 函数 4: (新增) 一键发布已批准的角色 vvv ---
/**
 * [核心功能] 一键发布已批准的角色
 * 1. 查找 CharacterSubmissions 表中所有 status 为 'approved' 的记录。
 * 2. 获取当前 Character 表中最大的 ID，用于生成新 ID。
 * 3. 遍历所有已批准的提交：
 *    a. 在 Character 表中创建一个新角色。
 *    b. 将提交记录的 status 更新为 'published'，防止重复发布。
 * 4. 返回处理结果。
 */
AV.Cloud.define('publishApprovedCharacters', async (request) => {
  // 1. 查询所有已批准的提交
  const submissionQuery = new AV.Query('CharacterSubmissions');
  submissionQuery.equalTo('status', 'approved');
  const submissions = await submissionQuery.find();

  if (submissions.length === 0) {
    return '没有找到待发布的角色。';
  }

  // 2. 获取当前官方角色中的最大 ID
  const charQuery = new AV.Query('Character');
  charQuery.descending('id'); // 按 id 降序排序
  charQuery.limit(1); // 只取最大的那一个
  const maxIdChar = await charQuery.first();
  let maxId = maxIdChar ? maxIdChar.get('id') : 0; // 如果表为空，则从 0 开始

  let successCount = 0;
  const failedSubmissions = [];

  // 3. 遍历并发布每一个提交
  for (const submission of submissions) {
    try {
      const submissionData = submission.get('characterData');
      const imageUrl = submission.get('imageUrl');
      const newId = ++maxId; // ID 递增

      // 3a. 创建新角色对象并设置属性
      const Character = AV.Object.extend('Character');
      const newChar = new Character();
      newChar.set('id', newId);
      newChar.set('name', submissionData.name);
      newChar.set('description', submissionData.description);
      newChar.set('imageUrl', imageUrl); // 使用上传到七牛云的 URL
      newChar.set('characterPrompt', submissionData.characterPrompt);
      newChar.set('userProfilePrompt', submissionData.userProfilePrompt);
      newChar.set('storyBackgroundPrompt', submissionData.storyBackgroundPrompt);
      newChar.set('storyStartPrompt', submissionData.storyStartPrompt);
      
      // 使用 masterKey 保存，无视 ACL 限制
      await newChar.save(null, { useMasterKey: true });

      // 3b. 更新提交记录的状态为 'published'
      submission.set('status', 'published');
      await submission.save();

      successCount++;
    } catch (error) {
      console.error(`发布角色失败，Submission ID: ${submission.id}, 错误:`, error);
      failedSubmissions.push(submission.id);
    }
  }

  // 4. 返回最终结果
  let resultMessage = `发布完成！成功发布 ${successCount} 个角色。`;
  if (failedSubmissions.length > 0) {
    resultMessage += ` 失败 ${failedSubmissions.length} 个，ID: ${failedSubmissions.join(', ')}。请检查日志。`;
  }
  return resultMessage;
});
// --- ^^^ 以上是所有需要添加的代码 ^^^ ---
