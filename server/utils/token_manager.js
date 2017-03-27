// var redisClient = require('./redis_database').redisClient;
// var setting = require('../config/setting');
// var TOKEN_EXPIRATION = 60;
// var TOKEN_EXPIRATION_SEC = setting.TOKEN_EXPIRATION_SEC;

var _ = require('lodash')
var jwt = require('jsonwebtoken');
var exjwt = require('express-jwt');
var setting = require('../config/setting');
var async = require('async');
var log = require('./log');               // 日志系统

/**
 * 验证token是否有效，token存储在redis中
 */
var verifyToken = exports.verifyToken = function (req, res, next) {
	var token = getToken(req);

	redisClient.get(token, function (err, reply) {
		if (err || !reply) {
			console.log(err);
			return res.sendStatus(401);
		}else{
			var user = JSON.parse(reply);
			if(checkAdminType(req, user)){
				req.user = _.merge(req.user, user);	
				next();
			}else{
				return res.sendStatus(401);
			}	
		}
	});
};

var jwtOptions = {
        secret: setting.secretToken,
        // credentialsRequired: true,
        getToken: getToken
    };

// 更新后台redistoken 过期时间，未鉴权的接口使用
exports.touchToken = function(req, res, next){
	// res.header('updated-x-access-token', req.headers['x-access-token']);
	next();
	var token = getToken(req);
	if(token){
		redisClient.get(token, function (err, reply) {
			if(!err && reply){
				/**
				 * 如果token存在更新token过期时间
				 */
				redisClient.expire(token, TOKEN_EXPIRATION_SEC/2);
			}
		});
	}
}

// 校验token合法性，是否超时等
exports.validateToken = function(req, res, next){
	// res.set('x-access-token', "11212121");
	var token = getToken(req);
	if(!token){
		return res.sendStatus(401);
	}
	async.waterfall([
		function(cb){  //验证是否在redis中存在, 获取user信息
			var user = null;
			redisClient.get(token, function (err, reply) {
					if(!err && reply){
						try{
							var user = JSON.parse(reply);
							user.id = user._id; // 兼容旧的req.user
							req.user = user; // 添加req.user 传递给后续
							/**
							 * 如果token存在更新token过期时间
							 */
							redisClient.expire(token, TOKEN_EXPIRATION_SEC);
							cb(null, user);
						}catch(e){
							cb(new Error("token不存在"),null);
						}
					}else{
						// 不存在redis中 调到最后
						cb(new Error("token不存在"),null);
					}
				});
		},
		function(user, cb){  //验证是否adminType 权限
			if(!checkAdminType(req, user)){
				cb(new Error("没有权限访问该路由"), null);
			}else{
				cb(null, user);
			}
		},
		function(user, cb){   //验证token 有效性
			jwt.verify(token, setting.secretToken, function(err, decoded) {
				if(err){
					if(err.name === "TokenExpiredError"){
						//重新生成加密后的token,返回前台
						var newToken = generateToken({id: user._id});
						// 更新headers
						req.headers['x-access-token'] = newToken;
						// 更新返回http中的token信息，前台拿到后需要更新token
						// res.headers['updated-x-access-token'] = newToken;
						// res.headers['updated-x-access-token'] = newToken;
						//删掉旧的token
						redisClient.del(token);
						res.header('updated-x-access-token', newToken);
						saveTokenToRedis(newToken, JSON.stringify(user), function(){
							cb(null, user);
						});
					}else{
						cb(err, null);
					}
				}else{
					cb(null, user);
				}	
			});
		}
	],function(err, result){
		if(err){
			return res.status(401).send(err.message);
		}else{
			next();
		}
	});
}


/**
 * 检查adminType 0 为管理员 1 为普通用户 只能访问 pc的接口
 */
function checkAdminType(req, user){
	var url = req.url;   //"/api/admins"
	var adminType = user.adminType;
	switch(adminType){
		case 1:  // PC端用户

			if(_.startsWith(url, '/api/pc/') || _.startsWith(url, '/api/app/')){
				return true;
			}
			break;
		case 0:  // 管理员用户
			if(_.startsWith(url, '/api/')){
				return true;
			}
			break;
		default:  // 没有adminType设置的用户，不允许访问
			return false;
	}
}


/**
 * 存储token到redis里，缓存用户数据
 */
var saveToken = exports.saveToken = function(user, callback){

	//在调用的时候加载Roles表
	var Roles = require('mongoose').model('Roles');

	//以下是异步流程控制，先取role的权限
        async.waterfall([
            function(cb){   //获取role权限
              //获取权限列表
              if(user.role){
				  if(_.isArray(user.role)){
					 return cb(null, user.role); 	
				  }
                Roles.findById(user.role, function(err, doc){
                  if(!err && doc){
					cb(null, doc.authorities);
                  }else{
					log.error(err);
					cb(err, {});
                  }
                });
              }else{
					cb(null, {});
				}
            }
          ],function(err, role){
              // 整理token对应的数据，存到redis里
                var tokenData = {
                    _id:user._id,
                    email:user.email,
					adminType:user.adminType,
                    name:user.name,
                    role:role?role:null,  //权限组
                    tel:user.tel,
                    avator:user.avator  //头像
                }

                //生成加密后的token,返回前台
                var token = generateToken({id: user._id});
				// log.debug('token:'+token);
				// 返回token到调用的函数
				callback(token);	

                // 存储token 和toke对应的用户信息到redis里
				if (token != null) {
					saveTokenToRedis(token, JSON.stringify(tokenData));
				}

                // 返回前台token
                // return res.json(message.createReturn(message.SUCCESS, {token:token}));
            });


}

// 保存token到redis 并设置过期时间
function saveTokenToRedis(token, tokenData, callback){
	redisClient.set(token, tokenData, function(err,reply){
		// 半小时内 无操作，token失效
		redisClient.expire(token, TOKEN_EXPIRATION_SEC/2, function (err, reply) {
			if(callback) callback();
		});
	})
}

// 生成加密后的token
function generateToken(content){
	return jwt.sign(
		content,
		setting.secretToken,
		{ expiresIn: TOKEN_EXPIRATION_SEC }
	);
}

/**
 * 删除redis中的token，使过期
 */
exports.expireToken = function(req) {
	var token = getToken(req);
	redisClient.del(token);
	// if (token != null) {
	// 	redisClient.set(token, { is_expired: true });
    // 	redisClient.expire(token, TOKEN_EXPIRATION_SEC);
	// }
};

/**
 * 更新token
 */
exports.updateToken = function(req, callback) {
	var token = getToken(req);
	redisClient.get(token, function (err, reply) {
		if (err || !reply) {
			console.log(err);
			return res.sendStatus(401);
		}else{
			var user = JSON.parse(reply);
			saveToken(user, function(newToken){
				//删掉旧token
				redisClient.del(token);
				if(callback) callback(newToken);
			})
		}
	});
	// if (token != null) {
	// 	redisClient.set(token, { is_expired: true });
    // 	redisClient.expire(token, TOKEN_EXPIRATION_SEC);
	// }
};


var getToken = exports.getToken = function(req) {
	if (req.headers && req.headers['x-access-token']) {
		return req.headers['x-access-token'];
	}
	else {
		return null;
	}
};


// exports.TOKEN_EXPIRATION_SEC = TOKEN_EXPIRATION_SEC;