# koishi-plugin-maimai-guess-song

[![npm](https://img.shields.io/npm/v/koishi-plugin-maimai-guess-song?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-maimai-guess-song)

maimai听歌猜曲

播放5s歌曲片段，用户在1分钟内猜歌。支持别名匹配，支持部分匹配，匹配连续3个汉字或6个字符

支持按歌曲流派/等级筛选猜歌范围，默认全曲库
支持积分系统，猜对后增加积分，猜歌范围过小会影响积分，困难模式（播放更短片段）提高积分倍率
支持连续多轮猜歌比赛排名

默认歌曲数据API：https://www.diving-fish.com/api/maimaidxprober/music_data
别名数据API：https://oss.lista233.cn/alias.json
可在插件配置中修改

需要安装ffmpeg，并在 [Release](https://github.com/LambSpine/maimai-guess-song/releases) 下载音频资源解压到插件配置的目录
缺少歌曲restricted access，自己找资源补一下吧
