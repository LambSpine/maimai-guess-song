import { Context, Schema, h, Logger } from 'koishi'
import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'

const logger = new Logger('maimai-guess-song')

const STORAGE_DIR = path.join(process.cwd(), 'data', 'maimai-guess-song')
const STORAGE_FILE = path.join(STORAGE_DIR, 'song-cache.json')
const SCORE_FILE = path.join(STORAGE_DIR, 'user-scores.json')

// 确保存储目录存在
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true })
}

export const name = 'maimai-guess-song'

export interface Config {
  musicDataUrl: string
  aliasDataUrl: string
  audioDir: string
}

interface UserScore {
  [userId: string]: number
}

interface GuessGame {
  channelId: string
  currentSong: SongData | null
  startTime: number | null
  active: boolean
  session: any | null
  timerId: NodeJS.Timeout | null
  songCount: number // 参与随机的歌曲数量
  difficulty: number // 难度等级 0-4
  totalRounds: number // 总轮数
  currentRound: number // 当前轮数
  roundResults: { userId: string; songId: string; correct: boolean; points: number }[] // 每轮结果
  genre: string | undefined // 歌曲类别
  levelOption: string | undefined // 等级选项
}

export const Config: Schema<Config> = Schema.object({
  musicDataUrl: Schema.string()
    .default('https://www.diving-fish.com/api/maimaidxprober/music_data')
    .description('歌曲数据 API 地址'),
  aliasDataUrl: Schema.string()
    .default('https://oss.lista233.cn/alias.json')
    .description('别名数据 API 地址'),
  audioDir: Schema.string()
    .default(path.join(process.cwd(), 'data', 'maimai-guess-song', 'audio'))
    .description('音频文件目录'),
})

interface SongData {
  id: string
  title: string
  type: string
  ds: number[]
  level: string[]
  charts: ChartData[]
  basic_info: {
    title: string
    artist: string
    genre: string
    bpm: string
    from: string
    is_new: boolean
  }
}

interface ChartData {
  notes: number[]
  charter: string
}

interface AliasData {
  SongID: number
  Name: string
  Alias: string[]
}

interface SongCache {
  musicData: SongData[]
  aliasData: AliasData[]
  lastUpdate: number
}

// 加载本地缓存
function loadCache(): SongCache {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf8')
      const cache = JSON.parse(data)
      logger.info(`从本地加载歌曲缓存，共 ${cache.musicData.length} 首歌曲，${cache.aliasData.length} 条别名数据`)
      return cache
    }
  } catch (error) {
    logger.error('加载本地缓存失败:', error)
  }
  return {
    musicData: [],
    aliasData: [],
    lastUpdate: 0
  }
}

// 保存缓存到本地
function saveCache(cache: SongCache): void {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(cache, null, 2))
    logger.info('歌曲缓存已保存到本地')
  } catch (error) {
    logger.error('保存本地缓存失败:', error)
  }
}

// 加载用户积分
function loadScores(): UserScore {
  try {
    if (fs.existsSync(SCORE_FILE)) {
      const data = fs.readFileSync(SCORE_FILE, 'utf8')
      return JSON.parse(data)
    }
  } catch (error) {
    logger.error('加载用户积分失败:', error)
  }
  return {}
}

// 保存用户积分
function saveScores(scores: UserScore): void {
  try {
    fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2))
    logger.info('用户积分已保存')
  } catch (error) {
    logger.error('保存用户积分失败:', error)
  }
}

// 获取用户积分
function getUserScore(userId: string): number {
  const scores = loadScores()
  return scores[userId] || 0
}

// 增加用户积分
function addUserScore(userId: string, points: number): void {
  const scores = loadScores()
  scores[userId] = (scores[userId] || 0) + points
  saveScores(scores)
}

// 随机截取音频片段
function extractAudioClip(audioPath: string, duration: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 获取音频时长
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }

      const totalDuration = metadata.format.duration || 0
      if (totalDuration <= duration) {
        // 如果音频时长小于等于截取时长，直接返回原文件
        resolve(audioPath)
        return
      }

      // 随机选择起始时间（确保有足够的时长截取）
      const maxStartTime = totalDuration - duration
      const startTime = Math.random() * maxStartTime

      // 生成临时文件路径
      const tempDir = path.join(STORAGE_DIR, 'temp')
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }
      const clipPath = path.join(tempDir, `clip_${Date.now()}.mp3`)

      // 使用ffmpeg截取音频
      ffmpeg(audioPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .output(clipPath)
        .on('end', () => {
          logger.info(`音频截取成功: ${startTime.toFixed(2)}s - ${(startTime + duration).toFixed(2)}s`)
          resolve(clipPath)
        })
        .on('error', (err) => {
          reject(err)
        })
        .run()
    })
  })
}

export function apply(ctx: Context, config: Config) {
  let songCache: SongCache = loadCache()
  let userScores: UserScore = loadScores()
  let guessGames: Map<string, GuessGame> = new Map()

  function getGame(channelId: string): GuessGame {
    if (!guessGames.has(channelId)) {
      guessGames.set(channelId, {
        channelId,
        currentSong: null,
        startTime: null,
        active: false,
        session: null,
        timerId: null,
        songCount: 0,
        difficulty: 0,
        totalRounds: 1,
        currentRound: 0,
        roundResults: [],
        genre: undefined,
        levelOption: undefined
      })
    }
    return guessGames.get(channelId)!
  }

  // 重置游戏状态
  function resetGame(guessGame: GuessGame): void {
    guessGame.currentSong = null
    guessGame.startTime = null
    guessGame.active = false
    guessGame.session = null
    if (guessGame.timerId) {
      clearTimeout(guessGame.timerId)
      guessGame.timerId = null
    }
    guessGame.songCount = 0
    guessGame.difficulty = 0
    guessGame.totalRounds = 1
    guessGame.currentRound = 0
    guessGame.roundResults = []
    guessGame.genre = undefined
    guessGame.levelOption = undefined
  }

  // 生成排名
  function getRanking(results: { userId: string; songId: string; correct: boolean; points: number }[]): string {
    // 按用户分组计算总分
    const userScores: { [userId: string]: number } = {}
    for (const result of results) {
      if (result.correct) {
        userScores[result.userId] = (userScores[result.userId] || 0) + result.points
      }
    }

    // 转换为数组并排序
    const sortedUsers = Object.entries(userScores)
      .map(([userId, score]) => ({ userId, score }))
      .sort((a, b) => b.score - a.score)

    // 生成排名信息
    if (sortedUsers.length === 0) {
      return '无人答对任何歌曲'
    }

    let ranking = '🏆 排名：\n'
    sortedUsers.forEach((user, index) => {
      ranking += `${index + 1}. 用户 ${user.userId} - ${user.score} 分\n`
    })

    return ranking
  }

  // 处理猜对后的逻辑
  async function handleCorrectGuess(session: any, guessGame: GuessGame, userId: string, song: SongData): Promise<void> {
    if (guessGame.timerId) {
      clearTimeout(guessGame.timerId)
      guessGame.timerId = null
    }
    guessGame.active = false
    
    // 根据难度等级计算得分倍数
    const difficultyMultipliers = [1, 1.5, 2, 2.5, 3] // 难度 0-4
    const multiplier = difficultyMultipliers[guessGame.difficulty] || 1
    
    // 计算基础积分（参与随机的歌曲数量，最多100分）
    const basePoints = Math.min(guessGame.songCount, 100)
    
    // 计算最终积分（基础积分 × 难度倍数，取整数）
    const points = Math.round(basePoints * multiplier)
    
    addUserScore(userId, points)
    userScores = loadScores()

    // 记录本轮结果
    guessGame.roundResults.push({
      userId,
      songId: song.id,
      correct: true,
      points
    })
    guessGame.currentRound++

    const score = userScores[userId] || 0
    let message = []

    // 在群聊中@玩家
    if (session.channelId && !session.isDirect) {
      message.push(`🎉 恭喜！<at id="${userId}"/> 猜对了！`)
    } else {
      message.push(`🎉 恭喜！你猜对了！`)
    }

    message.push(
      `歌曲: ${song.title}`,
      `ID: ${song.id}`,
      `你的积分: ${score}`
    )

    // 检查是否需要开始下一轮
    if (guessGame.currentRound < guessGame.totalRounds) {
      message.push(`\n第 ${guessGame.currentRound + 1}/${guessGame.totalRounds} 轮开始！`)
      await session.send(message.join('\n'))
      // 延迟1秒开始下一轮
      setTimeout(async () => {
        await startGuessGame(session, guessGame, guessGame.genre, guessGame.levelOption)
      }, 1000)
    } else {
      // 所有轮次完成，显示排名（仅当总轮数大于1时）
      if (guessGame.totalRounds > 1) {
        message.push(`\n🎉 所有 ${guessGame.totalRounds} 轮猜歌完成！`)
        message.push(getRanking(guessGame.roundResults))
      }
      await session.send(message.join('\n'))
      // 重置游戏状态
      resetGame(guessGame)
    }
  }

  // 监听所有消息，自动检测猜歌答案
  ctx.middleware(async (session, next) => {
    const channelId = session.channelId || session.guildId || 'private'
    const guessGame = getGame(channelId)

    // 如果没有进行中的游戏，继续处理其他命令
    if (!guessGame.active || !guessGame.currentSong) {
      return next()
    }

    // 获取消息内容
    const content = session.content?.trim()
    if (!content) return next()

    const userId = session.userId || 'unknown'
    const song = guessGame.currentSong
    const answerLower = content.toLowerCase()
    const songTitle = song.title.toLowerCase()
    const songBasicTitle = song.basic_info.title.toLowerCase()

    const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === song.id)
    const allAliases = aliasInfo?.Alias || []
    const aliasNames = allAliases.map(a => a.toLowerCase())

    const exactMatch = answerLower === songTitle ||
      answerLower === songBasicTitle ||
      aliasNames.includes(answerLower)

    const partialMatch = songTitle.includes(answerLower) ||
      songBasicTitle.includes(answerLower) ||
      aliasNames.some(alias => alias.includes(answerLower))

    // 完全匹配
    if (exactMatch) {
      await handleCorrectGuess(session, guessGame, userId, song)
      return
    }

    // 部分匹配（需要满足长度要求）
    if (partialMatch) {
      const isChinese = /[\u4e00-\u9fa5]/.test(content)
      const matchLength = content.length
      const requiredLength = isChinese ? 3 : 6

      if (matchLength >= requiredLength) {
        await handleCorrectGuess(session, guessGame, userId, song)
        return
      }
    }

    // 不匹配，继续处理其他命令
    return next()
  })

  async function fetchMusicData(): Promise<SongData[]> {
    try {
      const response = await ctx.http.get<SongData[]>(config.musicDataUrl)
      return response
    } catch (error) {
      logger.error('获取歌曲数据失败:', error)
      throw error
    }
  }

  async function fetchAliasData(): Promise<AliasData[]> {
    try {
      const response = await ctx.http.get<AliasData[] | { content: AliasData[] }>(config.aliasDataUrl)
      if (Array.isArray(response)) {
        return response
      }
      return response.content || []
    } catch (error) {
      logger.error('获取别名数据失败:', error)
      throw error
    }
  }

  function findSongByKeyword(keyword: string): { song: SongData | null, aliases: string[], multiple: boolean, allMatches: SongData[] } {
    const searchTerm = keyword.toLowerCase().trim()
    
    // 按ID精确匹配
    const songById = songCache.musicData.find(song => song.id === searchTerm)
    if (songById) {
      const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === songById.id)
      return { 
        song: songById, 
        aliases: aliasInfo?.Alias || [],
        multiple: false,
        allMatches: [songById]
      }
    }

    // 按标题模糊匹配
    const songsByTitle = songCache.musicData.filter(song => 
      song.title.toLowerCase().includes(searchTerm) ||
      song.basic_info.title.toLowerCase().includes(searchTerm)
    )
    if (songsByTitle.length > 0) {
      const firstSong = songsByTitle[0]
      const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === firstSong.id)
      return { 
        song: firstSong, 
        aliases: aliasInfo?.Alias || [],
        multiple: songsByTitle.length > 1,
        allMatches: songsByTitle
      }
    }

    // 按别名模糊匹配
    const aliasMatches = songCache.aliasData.filter(aliasData => 
      aliasData.Name.toLowerCase().includes(searchTerm) ||
      aliasData.Alias.some(alias => alias.toLowerCase().includes(searchTerm))
    )
    if (aliasMatches.length > 0) {
      const firstAlias = aliasMatches[0]
      const song = songCache.musicData.find(s => s.id === firstAlias.SongID.toString())
      const allSongs = aliasMatches.map(alias => 
        songCache.musicData.find(s => s.id === alias.SongID.toString())
      ).filter((s): s is SongData => s !== undefined)
      return { 
        song: song || null, 
        aliases: firstAlias.Alias,
        multiple: allSongs.length > 1,
        allMatches: allSongs
      }
    }

    return { song: null, aliases: [], multiple: false, allMatches: [] }
  }

  const songCmd = ctx.command('song', 'maimai 歌曲相关命令')

  songCmd.subcommand('.refresh', '刷新歌曲数据库')
    .alias('歌曲刷新')
    .action(async ({ session }) => {
      if (!session) return

      try {
        await session.send('正在获取歌曲数据，请稍候...')

        const [musicData, aliasData] = await Promise.all([
          fetchMusicData(),
          fetchAliasData()
        ])

        songCache.musicData = musicData
        songCache.aliasData = aliasData
        songCache.lastUpdate = Date.now()

        // 保存到本地
        saveCache(songCache)

        const message = [
          '歌曲数据库刷新成功！',
          `共获取 ${musicData.length} 首歌曲`,
          `共获取 ${aliasData.length} 条别名数据`,
          `更新时间: ${new Date().toLocaleString('zh-CN')}`
        ].join('\n')

        return message
      } catch (error) {
        logger.error('刷新歌曲数据库失败:', error)
        return '刷新歌曲数据库失败，请稍后重试'
      }
    })

  songCmd.subcommand('.alias <keyword:text>', '查询歌曲别名')
    .alias('歌曲别名')
    .example('song alias 天界')
    .action(async ({ session }, keyword) => {
      if (!session) return

      if (!keyword) {
        return '请输入要查询的歌曲名称或ID'
      }

      if (songCache.musicData.length === 0) {
        return '歌曲数据库为空，请先使用 song refresh 命令刷新数据'
      }

      try {
        const { song, aliases, multiple, allMatches } = findSongByKeyword(keyword)

        if (!song) {
          return `未找到与 "${keyword}" 相关的歌曲`
        }

        // 处理多匹配情况
        if (multiple) {
          const message = [
            `找到 ${allMatches.length} 首匹配的歌曲：`,
            ...allMatches.map((match, index) => {
              const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === match.id)
              const matchAliases = aliasInfo?.Alias || []
              return `${index + 1}. ${match.title} (ID: ${match.id}) ${matchAliases.length > 0 ? `[别名: ${matchAliases.slice(0, 2).join(', ')}${matchAliases.length > 2 ? '...' : ''}]` : ''}`
            }),
            '',
            '请使用更精确的关键词或歌曲ID查询' 
          ]
          return message.join('\n')
        }

        const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === song.id)
        const allAliases = aliasInfo?.Alias || []

        if (allAliases.length === 0) {
          return [
            `歌曲: ${song.title}`,
            `ID: ${song.id}`,
            '该歌曲暂无别名'
          ].join('\n')
        }

        const message = [
          `歌曲: ${song.title}`,
          `ID: ${song.id}`,
          `曲师: ${song.basic_info.artist}`,
          `版本: ${song.basic_info.from}`,
          `BPM: ${song.basic_info.bpm}`,
          '',
          `别名 (${allAliases.length}个):`,
          allAliases.map((alias, index) => `${index + 1}. ${alias}`).join('\n')
        ].join('\n')

        return message
      } catch (error) {
        logger.error('查询歌曲别名失败:', error)
        return '查询失败，请稍后重试'
      }
    })

  songCmd.subcommand('.search <keyword:text>', '搜索歌曲')
    .alias('搜索歌曲')
    .example('song search 天界')
    .action(async ({ session }, keyword) => {
      if (!session) return

      if (!keyword) {
        return '请输入要搜索的歌曲名称或ID'
      }

      if (songCache.musicData.length === 0) {
        return '歌曲数据库为空，请先使用 song refresh 命令刷新数据'
      }

      try {
        const { song, aliases, multiple, allMatches } = findSongByKeyword(keyword)

        if (!song) {
          return `未找到与 "${keyword}" 相关的歌曲`
        }

        // 处理多匹配情况
        if (multiple) {
          const message = [
            `找到 ${allMatches.length} 首匹配的歌曲：`,
            ...allMatches.map((match, index) => {
              return `${index + 1}. ${match.title} (ID: ${match.id})`
            }),
            '',
            '请使用更精确的关键词或歌曲ID查询' 
          ]
          return message.join('\n')
        }

        const difficultyNames = ['Basic', 'Advanced', 'Expert', 'Master', 'Re:Master']
        const difficulties = song.ds.map((ds, index) => {
          return `${difficultyNames[index]}: ${song.level[index]} (${ds})`
        }).filter((_, index) => song.level[index] !== '-')

        const message = [
          `歌曲: ${song.title}`,
          `ID: ${song.id}`,
          `类型: ${song.type}`,
          `曲师: ${song.basic_info.artist}`,
          `类别: ${song.basic_info.genre}`,
          `版本: ${song.basic_info.from}`,
          `BPM: ${song.basic_info.bpm}`,
          '',
          '难度:',
          ...difficulties
        ].join('\n')

        return message
      } catch (error) {
        logger.error('搜索歌曲失败:', error)
        return '搜索失败，请稍后重试'
      }
    })

  ctx.command('猜歌 [genre:string]', '开始猜歌游戏，可选类别和等级筛选')
    .alias('guess')
    .option('level', '-l <level> 指定歌曲等级或等级范围，支持格式：12+、13+-14')
    .option('difficulty', '-d <difficulty> 困难模式，指定难度等级1-4，难度越高音频越短，得分倍数越高')
    .option('number', '-n <number> 连续进行n次猜歌，结束时输出排名')
    .example('猜歌')
    .example('猜歌 东方')
    .example('猜歌 -l 12+')
    .example('猜歌 nico -l 12+-14 -d 1 -n 5')
    .action(async ({ session, options }, genre) => {
      if (!session) return

      const channelId = session.channelId || session.guildId || 'private'
      const guessGame = getGame(channelId)
      const levelOption = (options as any).level
      const hardOption = (options as any).difficulty
      const numberOption = (options as any).number
      
      if (songCache.musicData.length === 0) {
        return '歌曲数据库为空，请先使用 song refresh 命令刷新数据'
      }

      if (guessGame.active) {
        return '当前已有猜歌游戏进行中，请等待当前游戏结束'
      }

      // 验证难度等级
      let difficulty = 0
      if (hardOption) {
        logger.info(`收到难度选项: ${hardOption}, 类型: ${typeof hardOption}`)
        const parsedDifficulty = parseInt(hardOption)
        logger.info(`解析后的难度: ${parsedDifficulty}, 类型: ${typeof parsedDifficulty}`)
        if (parsedDifficulty >= 0 && parsedDifficulty <= 4) {
          difficulty = parsedDifficulty
          logger.info(`设置难度等级: ${difficulty}`)
        } else {
          logger.info(`难度验证失败: ${parsedDifficulty} 不在 0-4 范围内`)
          return '难度等级必须在0-4之间'
        }
      }
      guessGame.difficulty = difficulty
      logger.info(`最终难度等级: ${guessGame.difficulty}`)
      
      // 验证连续猜歌轮数
      let totalRounds = 1
      if (numberOption) {
        const parsedNumber = parseInt(numberOption)
        if (parsedNumber >= 1 && parsedNumber <= 10) {
          totalRounds = parsedNumber
        } else {
          return '连续猜歌轮数必须在1-10之间'
        }
      }
      guessGame.totalRounds = totalRounds
      guessGame.currentRound = 0
      guessGame.roundResults = []
      guessGame.genre = genre
      guessGame.levelOption = levelOption
      logger.info(`设置连续猜歌轮数: ${totalRounds}`)

      try {
        await startGuessGame(session, guessGame, genre, levelOption)
      } catch (error) {
        logger.error('开始猜歌游戏失败:', error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        return `开始猜歌游戏失败: ${errorMessage}`
      }
    })

  async function startGuessGame(session: any, guessGame: GuessGame, genre: string | undefined, levelOption: string | undefined): Promise<void> {
    // 使用游戏实例中保存的参数
    const gameGenre = guessGame.genre || genre
    const gameLevelOption = guessGame.levelOption || levelOption
    
    // 将歌曲ID映射到基础ID（大于10000的减去10000），然后去重，过滤掉ID大于100000的特殊歌曲
    const seenBaseIds = new Set<string>()
    const uniqueSongs = songCache.musicData.filter(song => {
      const songId = parseInt(song.id)
      // 过滤掉ID大于100000的特殊歌曲
      if (songId > 100000) {
        return false
      }
      // 按类别筛选
      if (gameGenre) {
        const songGenre = song.basic_info.genre.toLowerCase()
        const targetGenre = gameGenre.toLowerCase()
        
        // 检查是否为中文输入
        const isChineseInput = /[\u4e00-\u9fa5]/.test(gameGenre)
        const minLength = isChineseInput ? 2 : 4
        
        // 模糊匹配：只要包含目标字符串且长度达标
        if (targetGenre.length < minLength || !songGenre.includes(targetGenre)) {
          return false
        }
      }
      // 按等级筛选
      if (gameLevelOption) {
        const hasMatchingLevel = song.level.some(lvl => {
          if (lvl === '-') return false
          
          // 解析等级选项，支持 "12+"、"12-14"、"12+-13"、"12" 等格式
            if (gameLevelOption.includes('-')) {
              // 用户输入 "12-14" 或 "12+-13" 等范围格式
              const [start, end] = gameLevelOption.split('-')
              
              // 解析起始等级
              const startValue = start.includes('+') 
                ? parseInt(start) + 0.5 
                : parseInt(start)
              
              // 解析结束等级
              const endValue = end.includes('+') 
                ? parseInt(end) + 0.5 
                : parseInt(end)
              
              if (isNaN(startValue) || isNaN(endValue)) return false
              
              // 将等级字符串转换为数值进行比较
              // "12+" -> 12.5, "13+" -> 13.5, "12" -> 12, "13" -> 13
              const lvlValue = lvl.includes('+') 
                ? parseInt(lvl) + 0.5 
                : parseInt(lvl)
              
              return lvlValue >= startValue && lvlValue <= endValue
            } else {
              // 用户输入 "12+" 或 "12" 等精确匹配格式
              return lvl === gameLevelOption
            }
        })
        if (!hasMatchingLevel) {
          return false
        }
      }
      const baseId = songId > 10000 ? (songId - 10000).toString() : song.id
      if (seenBaseIds.has(baseId)) {
        return false // 已存在该基础ID，跳过
      }
      seenBaseIds.add(baseId)
      return true
    })
    
    if (uniqueSongs.length === 0) {
      let errorMsg = '未找到可用于猜歌的歌曲'
      if (gameGenre && gameLevelOption) {
        errorMsg = `未找到类别包含 "${gameGenre}" 且等级为 "${gameLevelOption}" 的歌曲`
      } else if (gameGenre) {
        errorMsg = `未找到包含 "${gameGenre}" 的歌曲类别`
      } else if (gameLevelOption) {
        errorMsg = `未找到等级为 "${gameLevelOption}" 的歌曲`
      }
      throw new Error(errorMsg)
    }
    
    const randomSong = uniqueSongs[Math.floor(Math.random() * uniqueSongs.length)]
    guessGame.currentSong = randomSong
    guessGame.startTime = Date.now()
    guessGame.active = true
    guessGame.session = session
    guessGame.songCount = uniqueSongs.length // 设置参与随机的歌曲数量

    const audioFiles = fs.readdirSync(config.audioDir)
    const audioFile = audioFiles.find(file => {
      const fileId = file.split(' ')[0]
      // 处理ID大于10000的情况（n和n+10000看作同一首歌）
      let songId = parseInt(randomSong.id)
      if (songId > 10000) {
        songId = songId - 10000
      }
      // 将歌曲ID补齐4位数字进行匹配（例如：8 -> 0008）
      const paddedSongId = songId.toString().padStart(4, '0')
      return fileId === paddedSongId
    })

    if (!audioFile) {
      guessGame.active = false
      throw new Error(`找不到歌曲 ${randomSong.title} (ID: ${randomSong.id}) 的音频文件`)
    }

    const audioPath = path.join(config.audioDir, audioFile)
    logger.info(`音频文件路径: ${audioPath}`)

    let startMessage = guessGame.totalRounds > 1 
      ? `🎵 第 ${guessGame.currentRound + 1}/${guessGame.totalRounds} 轮猜歌游戏开始！请在1分钟内猜出歌曲名称或别名`
      : `🎵 猜歌游戏开始！请在1分钟内猜出歌曲名称或别名`
    if (gameGenre || gameLevelOption || guessGame.difficulty > 0) {
      const filters = []
      if (gameGenre) filters.push(`类别: ${randomSong.basic_info.genre}`)
      if (gameLevelOption) filters.push(`歌曲等级: ${gameLevelOption}`)
      if (guessGame.difficulty > 0) filters.push(`难度: ${guessGame.difficulty}`)
      startMessage += '\n' + filters.join(' | ')
    }
    if (!session) {
      throw new Error('会话不存在，无法开始游戏')
    }
    await session.send(startMessage)
    
    // 根据难度等级计算音频时长（5秒 - 难度等级秒数）
    const baseDuration = 5
    const duration = Math.max(1, baseDuration - guessGame.difficulty)
    const clipPath = await extractAudioClip(audioPath, duration)
    
    // 读取截取后的音频文件并转换为 base64
    const audioBuffer = fs.readFileSync(clipPath)
    const base64Audio = audioBuffer.toString('base64')
    const dataUrl = `data:audio/mpeg;base64,${base64Audio}`
    
    logger.info(`音频片段大小: ${audioBuffer.length} bytes`)
    await session.send(h.audio(dataUrl))
    
    // 清理临时文件
    try {
      fs.unlinkSync(clipPath)
    } catch (e) {
      logger.warn('清理临时音频文件失败:', e)
    }

    logger.info(`开始猜歌游戏: ${randomSong.title} (ID: ${randomSong.id})`)

    if (guessGame.timerId) {
      clearTimeout(guessGame.timerId)
      guessGame.timerId = null
      logger.info('清理旧的定时器')
    }

    guessGame.timerId = setTimeout(() => {
      logger.info(`定时器触发: ${Date.now()}`)
      if (guessGame.active && guessGame.currentSong) {
        revealAnswer(guessGame)
      }
    }, 60000)
    logger.info(`定时器已启动: ${Date.now()}`)
  }

  ctx.command('积分', '查看积分')
    .alias('score')
    .action(async ({ session }) => {
      if (!session) return

      const userId = session.userId || 'unknown'
      const score = getUserScore(userId)
      return `你的积分: ${score}`
    })

  ctx.command('公布答案', '公布猜歌答案')
    .alias('reveal')
    .action(async ({ session }) => {
      if (!session) return

      const channelId = session.channelId || session.guildId || 'private'
      const guessGame = getGame(channelId)

      if (!guessGame.active || !guessGame.currentSong) {
        return '当前没有进行中的猜歌游戏'
      }

      revealAnswer(guessGame)
      return
    })

  function revealAnswer(game: GuessGame): string {
    if (!game.currentSong) return '没有进行中的猜歌游戏'

    logger.info(`公布答案: ${Date.now()}`)

    if (game.timerId) {
      clearTimeout(game.timerId)
      game.timerId = null
    }

    const song = game.currentSong
    game.active = false
    game.currentSong = null
    game.startTime = null

    // 记录本轮结果（猜错）
    game.roundResults.push({
      userId: 'unknown',
      songId: song.id,
      correct: false,
      points: 0
    })
    game.currentRound++

    const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === song.id)
    const aliases = aliasInfo?.Alias || []

    let message = [
      '⏰ 时间到！公布答案',
      `歌曲: ${song.title}`,
      `ID: ${song.id}`,
      `曲师: ${song.basic_info.artist}`,
      `版本: ${song.basic_info.from}`,
      aliases.length > 0 ? `别名: ${aliases.join(', ')}` : ''
    ].join('\n')

    // 保存 session 引用
    const session = game.session
    
    // 检查是否需要开始下一轮
    if (game.currentRound < game.totalRounds && session) {
      message += `\n\n第 ${game.currentRound + 1}/${game.totalRounds} 轮开始！`
      // 发送答案消息
      session.send(message)
      // 延迟1秒开始下一轮
      setTimeout(async () => {
        try {
          // 使用游戏实例中保存的参数
          await startGuessGame(session, game, game.genre, game.levelOption)
        } catch (error) {
          logger.error('开始下一轮猜歌游戏失败:', error)
          if (session) {
            session.send(`开始下一轮猜歌游戏失败: ${error instanceof Error ? error.message : String(error)}`)
            resetGame(game)
          }
        }
      }, 1000)
    } else if (session) {
      // 所有轮次完成，显示排名（仅当总轮数大于1时）
      if (game.totalRounds > 1) {
        message += `\n\n🎉 所有 ${game.totalRounds} 轮猜歌完成！`
        message += `\n${getRanking(game.roundResults)}`
      }
      // 发送答案消息
      session.send(message)
      // 重置游戏状态
      resetGame(game)
    }

    game.session = null

    return message
  }

  ctx.on('ready', async () => {
    logger.info('maimai-guess-song 插件已加载')
    
    if (songCache.musicData.length === 0) {
      logger.info('本地缓存为空，正在自动刷新歌曲数据库...')
      try {
        const [musicData, aliasData] = await Promise.all([
          fetchMusicData(),
          fetchAliasData()
        ])

        songCache.musicData = musicData
        songCache.aliasData = aliasData
        songCache.lastUpdate = Date.now()

        // 保存到本地
        saveCache(songCache)

        logger.info(`歌曲数据库刷新成功！共获取 ${musicData.length} 首歌曲，${aliasData.length} 条别名数据`)
      } catch (error) {
        logger.error('自动刷新歌曲数据库失败:', error)
        logger.info('请使用 song refresh 命令手动刷新')
      }
    } else {
      logger.info(`使用本地缓存，共 ${songCache.musicData.length} 首歌曲，${songCache.aliasData.length} 条别名数据`)
      logger.info(`最后更新时间: ${new Date(songCache.lastUpdate).toLocaleString('zh-CN')}`)
    }
  })
}
