'use strict';
const express = require('express');
const AV = require('leanengine');

// 加载云函数
require('./cloud');

const app = express();

// 使用 LeanEngine 中间件
// 必须在所有自定义路由之前调用
app.use(AV.express());

// 允许 express 读取 JSON 格式的请求体
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

module.exports = app;
