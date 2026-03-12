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
  currentSong: SongData | null
  startTime: number | null
  active: boolean
  session: any | null
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
  let guessGame: GuessGame = {
    currentSong: null,
    startTime: null,
    active: false,
    session: null
  }

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

  function findSongByKeyword(keyword: string): { song: SongData | null, aliases: string[] } {
    const searchTerm = keyword.toLowerCase().trim()
    
    const songById = songCache.musicData.find(song => song.id === searchTerm)
    if (songById) {
      const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === songById.id)
      return { song: songById, aliases: aliasInfo?.Alias || [] }
    }

    const songByTitle = songCache.musicData.find(song => 
      song.title.toLowerCase().includes(searchTerm) ||
      song.basic_info.title.toLowerCase().includes(searchTerm)
    )
    if (songByTitle) {
      const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === songByTitle.id)
      return { song: songByTitle, aliases: aliasInfo?.Alias || [] }
    }

    const aliasMatch = songCache.aliasData.find(aliasData => 
      aliasData.Name.toLowerCase().includes(searchTerm) ||
      aliasData.Alias.some(alias => alias.toLowerCase().includes(searchTerm))
    )
    if (aliasMatch) {
      const song = songCache.musicData.find(s => s.id === aliasMatch.SongID.toString())
      return { song: song || null, aliases: aliasMatch.Alias }
    }

    return { song: null, aliases: [] }
  }

  ctx.command('song', 'maimai 歌曲相关命令')

  ctx.command('song/refresh', '刷新歌曲数据库')
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

  ctx.command('song/alias <keyword:text>', '查询歌曲别名')
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
        const { song, aliases } = findSongByKeyword(keyword)

        if (!song) {
          return `未找到与 "${keyword}" 相关的歌曲`
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

  ctx.command('song/search <keyword:text>', '搜索歌曲')
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
        const { song, aliases } = findSongByKeyword(keyword)

        if (!song) {
          return `未找到与 "${keyword}" 相关的歌曲`
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

  ctx.command('猜歌', '开始猜歌游戏')
    .alias('guess')
    .action(async ({ session }) => {
      if (!session) return

      if (songCache.musicData.length === 0) {
        return '歌曲数据库为空，请先使用 song refresh 命令刷新数据'
      }

      if (guessGame.active) {
        return '当前已有猜歌游戏进行中，请等待当前游戏结束'
      }

      try {
        // 将歌曲ID映射到基础ID（大于10000的减去10000），然后去重，过滤掉ID大于100000的特殊歌曲
        const seenBaseIds = new Set<string>()
        const uniqueSongs = songCache.musicData.filter(song => {
          const songId = parseInt(song.id)
          // 过滤掉ID大于100000的特殊歌曲
          if (songId > 100000) {
            return false
          }
          const baseId = songId > 10000 ? (songId - 10000).toString() : song.id
          if (seenBaseIds.has(baseId)) {
            return false // 已存在该基础ID，跳过
          }
          seenBaseIds.add(baseId)
          return true
        })
        const randomSong = uniqueSongs[Math.floor(Math.random() * uniqueSongs.length)]
        guessGame.currentSong = randomSong
        guessGame.startTime = Date.now()
        guessGame.active = true
        guessGame.session = session

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
          return `找不到歌曲 ${randomSong.title} (ID: ${randomSong.id}) 的音频文件`
        }

        const audioPath = path.join(config.audioDir, audioFile)
        logger.info(`音频文件路径: ${audioPath}`)

        await session.send('🎵 猜歌游戏开始！')
        await session.send('📝 请在1分钟内猜出歌曲名称或别名')
        
        // 随机截取5秒音频
        const clipPath = await extractAudioClip(audioPath, 5)
        
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

        setTimeout(() => {
          if (guessGame.active && guessGame.currentSong) {
            revealAnswer()
          }
        }, 60000)

        return '游戏开始！'
      } catch (error) {
        logger.error('开始猜歌游戏失败:', error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        return `开始猜歌游戏失败: ${errorMessage}`
      }
    })

  ctx.command('猜 <answer:text>', '猜歌答案')
    .action(async ({ session }, answer) => {
      if (!session) return

      if (!guessGame.active || !guessGame.currentSong) {
        return '当前没有进行中的猜歌游戏'
      }

      const userId = (session as any).user?.id || (session as any).userId || 'unknown'
      const song = guessGame.currentSong
      const answerLower = answer.toLowerCase().trim()
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

      if (exactMatch) {
        guessGame.active = false
        addUserScore(userId, 1)
        userScores = loadScores()
        
        const score = userScores[userId] || 0
        const message = [
          `🎉 恭喜！你猜对了！`,
          `歌曲: ${song.title}`,
          `ID: ${song.id}`,
          `你的积分: ${score}`
        ].join('\n')
        
        return message
      }

      if (partialMatch) {
        const isChinese = /[\u4e00-\u9fa5]/.test(answer)
        const matchLength = answer.length
        const requiredLength = isChinese ? 3 : 6

        if (matchLength >= requiredLength) {
          guessGame.active = false
          addUserScore(userId, 1)
          userScores = loadScores()
          
          const score = userScores[userId] || 0
          const message = [
            `🎉 恭喜！你猜对了！`,
            `歌曲: ${song.title}`,
            `ID: ${song.id}`,
            `你的积分: ${score}`
          ].join('\n')
          
          return message
        }
      }

      return '❌ 猜错了，请再试一次'
    })

  ctx.command('积分', '查看积分')
    .alias('score')
    .action(async ({ session }) => {
      if (!session) return

      const userId = (session as any).user?.id || (session as any).userId || 'unknown'
      const score = getUserScore(userId)
      return `你的积分: ${score}`
    })

  ctx.command('公布答案', '公布猜歌答案')
    .alias('reveal')
    .action(async ({ session }) => {
      if (!session) return

      if (!guessGame.active || !guessGame.currentSong) {
        return '当前没有进行中的猜歌游戏'
      }

      revealAnswer()
      return
    })

  function revealAnswer(): string {
    if (!guessGame.currentSong) return '没有进行中的猜歌游戏'

    const song = guessGame.currentSong
    guessGame.active = false
    guessGame.currentSong = null
    guessGame.startTime = null

    const aliasInfo = songCache.aliasData.find(alias => alias.SongID.toString() === song.id)
    const aliases = aliasInfo?.Alias || []

    const message = [
      '⏰ 时间到！公布答案',
      `歌曲: ${song.title}`,
      `ID: ${song.id}`,
      `曲师: ${song.basic_info.artist}`,
      `版本: ${song.basic_info.from}`,
      aliases.length > 0 ? `别名: ${aliases.join(', ')}` : ''
    ].join('\n')

    // 发送答案消息
    if (guessGame.session) {
      guessGame.session.send(message)
    }
    guessGame.session = null

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
