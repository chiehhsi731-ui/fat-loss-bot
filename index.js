const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use('/webhook', line.middleware(lineConfig));

app.post('/webhook', async (req, res) => {
  res.status(200).end();
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    } else if (event.type === 'follow') {
      await handleFollow(event);
    }
  }
});

async function handleFollow(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);
  await supabase.from('users').upsert({
    id: userId,
    display_name: profile.displayName,
    picture_url: profile.pictureUrl,
  });
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: `歡迎加入減脂挑戰！🏋️\n\n傳送「說明」查看所有指令\n或點下方選單開啟 APP 開始挑戰！`,
    }],
  });
}

async function handleMessage(event) {
  const userId = event.source.userId;
  // 正規化：全形空格→半形、多空格→單一空格
  const text = event.message.text.replace(/[　 ]/g, ' ').replace(/\s+/g, ' ').trim();

  await supabase.from('users').upsert({ id: userId });

  // 說明指令
  if (text === '說明' || text === 'help' || text === '?') {
    return replyText(event, `🏋️ 減脂挑戰指令說明\n\n📊 身體數據記錄\n體重 62.5 → 記錄體重\n體脂 21.3 → 記錄體脂\n飲水 500 → 記錄飲水(ml)\n\n🍱 飲食記錄\n早餐 雞胸飯 → 搜尋食物\n午餐 便當 500 → 直接記錄卡路里\n晚餐 地瓜 200 → 同上\n點心 水果 100 → 同上\n\n📈 查詢\n今日熱量 → 查看今日飲食\n我的進度 → 查看本週進度\n隊伍進度 → 查看隊友排行\n\n💪 開啟APP\n👉 https://liff.line.me/2010377807-QvlNPosn`);
  }

  // 體重記錄
  if (text.startsWith('體重')) {
    const weight = parseFloat(text.replace('體重', '').trim());
    if (isNaN(weight)) return replyText(event, '格式錯誤，請輸入：體重 62.5');
    await supabase.from('body_records').insert({ user_id: userId, weight, team_id: null });
    await updateStreak(userId);
    return replyText(event, `✅ 體重已記錄：${weight} kg\n🔥 繼續加油！`);
  }

  // 體脂記錄
  if (text.startsWith('體脂')) {
    const bodyFat = parseFloat(text.replace('體脂', '').trim());
    if (isNaN(bodyFat)) return replyText(event, '格式錯誤，請輸入：體脂 21.3');
    await supabase.from('body_records').insert({ user_id: userId, body_fat: bodyFat, team_id: null });
    return replyText(event, `✅ 體脂已記錄：${bodyFat}%`);
  }

  // 飲水記錄
  if (text.startsWith('飲水')) {
    const water = parseInt(text.replace('飲水', '').trim());
    if (isNaN(water)) return replyText(event, '格式錯誤，請輸入：飲水 500');
    await supabase.from('body_records').insert({ user_id: userId, water_ml: water, team_id: null });
    return replyText(event, `✅ 飲水已記錄：${water} ml 💧`);
  }

  // 飲食記錄：AI 自動判斷卡路里
  // 支援格式：早餐 雞胸肉、早餐 雞胸肉150克、早餐 雞胸肉 150g、早餐 便當 500
  const mealStartMatch = text.match(/^(早餐|午餐|晚餐|點心)\s+(.+)$/);
  if (mealStartMatch) {
    const mealType = mealStartMatch[1];
    const rawInput = mealStartMatch[2].trim();

    // 解析食物名稱與份量/克數
    // 格式1：食物名稱 + 數字（卡路里直接指定，如「便當 500」）
    const directCalMatch = rawInput.match(/^(.+?)\s+(\d+)\s*(?:kcal|卡)?$/);
    // 格式2：食物名稱內含克數（如「雞胸肉150克」「雞胸肉 150g」）
    const gramInNameMatch = rawInput.match(/^(.+?)\s*(\d+)\s*(?:克|g|公克)$/i);

    let foodName, grams, directCal;

    if (gramInNameMatch) {
      foodName = gramInNameMatch[1].trim();
      grams = parseInt(gramInNameMatch[2]);
    } else if (directCalMatch) {
      foodName = directCalMatch[1].trim();
      directCal = parseInt(directCalMatch[2]);
    } else {
      foodName = rawInput;
    }

    // 查資料庫
    const { data: foods } = await supabase
      .from('food_database')
      .select('*')
      .ilike('name', `%${foodName}%`)
      .limit(1);

    let calories, calNote;

    if (directCal) {
      // 用戶直接指定卡路里
      calories = directCal;
      calNote = `${directCal} kcal`;
    } else if (foods && foods.length > 0) {
      // 資料庫找到，換算卡路里
      const food = foods[0];
      const actualGrams = grams || 100;
      calories = Math.round(food.calories_per_100g * actualGrams / 100);
      calNote = grams
        ? `${food.name} ${grams}g → ${calories} kcal`
        : `${food.name} 100g → ${calories} kcal`;
      foodName = food.name;
    } else {
      // 資料庫找不到，呼叫 Claude AI 估算
      try {
        const aiPrompt = grams
          ? `台灣食物「${foodName}」${grams}克的卡路里是多少？只回傳數字，不要任何說明、單位或文字。`
          : `台灣常見食物或飲料「${foodName}」一般份量的卡路里是多少？例如飲料以一杯(約500ml)計算，食物以一份計算。只回傳數字，不要任何說明、單位或文字。`;

        const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: aiPrompt }] }],
          }),
        });
        const aiData = await aiRes.json();
        const aiText = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        const aiCal = parseInt(aiText.replace(/[^0-9]/g, ''));
        if (aiCal && aiCal > 0 && aiCal < 5000) {
          calories = aiCal;
          calNote = grams
            ? `${foodName} ${grams}g → ${calories} kcal (AI估算)`
            : `${foodName} → ${calories} kcal (AI估算)`;
        } else {
          return replyText(event, `找不到「${foodName}」的熱量資料\n請改用：${mealType} ${foodName} [卡路里數字]\n例：${mealType} ${foodName} 300`);
        }
      } catch (e) {
        return replyText(event, `找不到「${foodName}」的熱量資料\n請改用：${mealType} ${foodName} [卡路里數字]\n例：${mealType} ${foodName} 300`);
      }
    }

    await supabase.from('meal_records').insert({
      user_id: userId,
      team_id: null,
      meal_type: mealType,
      food_name: foodName,
      calories,
    });

    // 查今日總卡路里
    const today = new Date().toISOString().split('T')[0];
    const { data: todayMeals } = await supabase
      .from('meal_records')
      .select('calories')
      .eq('user_id', userId)
      .gte('recorded_at', `${today}T00:00:00`);
    const todayTotal = todayMeals ? todayMeals.reduce((s, r) => s + r.calories, 0) : calories;

    // 查用戶目標熱量
    const { data: memberData } = await supabase
      .from('team_members')
      .select('calorie_goal')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - todayTotal;

    let summaryMsg;
    if (remaining > 0) {
      summaryMsg = `📊 今日 ${todayTotal} kcal／目標 ${goal} kcal\n還剩 ${remaining} kcal 可以吃`;
    } else {
      summaryMsg = `📊 今日 ${todayTotal} kcal／目標 ${goal} kcal\n⚠️ 已超標 ${Math.abs(remaining)} kcal`;
    }

    return replyText(event, `✅ ${mealType}已記錄\n${calNote}\n\n${summaryMsg}`);
  }

  // 今日熱量
  if (text === '今日熱量') {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('meal_records')
      .select('calories, meal_type, food_name')
      .eq('user_id', userId)
      .gte('recorded_at', `${today}T00:00:00`)
      .lte('recorded_at', `${today}T23:59:59`);

    if (!data || data.length === 0) return replyText(event, '今天還沒有飲食記錄 🍽️');
    const total = data.reduce((sum, r) => sum + r.calories, 0);
    const list = data.map(r => `${r.meal_type} ${r.food_name} ${r.calories}kcal`).join('\n');
    return replyText(event, `📊 今日飲食：\n${list}\n\n總計：${total} kcal`);
  }

  // 我的進度
  if (text === '我的進度') {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('body_records')
      .select('weight, body_fat, recorded_at')
      .eq('user_id', userId)
      .gte('recorded_at', weekAgo)
      .order('recorded_at', { ascending: false })
      .limit(7);

    if (!data || data.length === 0) return replyText(event, '本週還沒有記錄 📝');
    const latest = data[0];
    const oldest = data[data.length - 1];
    const weightDiff = latest.weight && oldest.weight ? (latest.weight - oldest.weight).toFixed(1) : null;
    let msg = `📈 本週進度（${data.length}/7天）\n`;
    if (latest.weight) msg += `體重：${latest.weight} kg`;
    if (weightDiff) msg += `（${weightDiff > 0 ? '+' : ''}${weightDiff}）`;
    if (latest.body_fat) msg += `\n體脂：${latest.body_fat}%`;
    return replyText(event, msg);
  }

  // 隊伍進度
  if (text === '隊伍進度') {
    // 找用戶所在隊伍
    const { data: myTeam } = await supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!myTeam) return replyText(event, '你還沒有加入任何隊伍 👥\n請先建立或加入隊伍');

    // 查隊伍所有成員
    const { data: members } = await supabase
      .from('team_members')
      .select('user_id, streak')
      .eq('team_id', myTeam.team_id);

    if (!members || members.length === 0) return replyText(event, '隊伍沒有成員資料');

    // 查每位成員最新體重體脂
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const memberIds = members.map(m => m.user_id);

    const { data: bodyData } = await supabase
      .from('body_records')
      .select('user_id, weight, body_fat, recorded_at')
      .in('user_id', memberIds)
      .gte('recorded_at', weekAgo)
      .order('recorded_at', { ascending: false });

    const { data: userInfos } = await supabase
      .from('users')
      .select('id, display_name')
      .in('id', memberIds);

    // 每人只取最新一筆
    const latestByUser = {};
    for (const r of (bodyData || [])) {
      if (!latestByUser[r.user_id]) latestByUser[r.user_id] = r;
    }
    const streakByUser = {};
    for (const m of members) streakByUser[m.user_id] = m.streak || 0;
    const nameByUser = {};
    for (const u of (userInfos || [])) nameByUser[u.id] = u.display_name || '隊友';

    // 排序：streak 高的在前
    const sorted = memberIds.sort((a, b) => (streakByUser[b] || 0) - (streakByUser[a] || 0));

    let msg = '👥 隊伍本週進度\n' + '─'.repeat(16) + '\n';
    for (const uid of sorted) {
      const name = nameByUser[uid] || '隊友';
      const streak = streakByUser[uid] || 0;
      const rec = latestByUser[uid];
      const isMe = uid === userId ? '（我）' : '';
      msg += `\n${name}${isMe} 🔥${streak}天\n`;
      if (rec) {
        if (rec.weight) msg += `  體重 ${rec.weight}kg`;
        if (rec.body_fat) msg += `  體脂 ${rec.body_fat}%`;
        msg += '\n';
      } else {
        msg += `  本週尚未記錄\n`;
      }
    }
    return replyText(event, msg);
  }
}

async function updateStreak(userId) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data } = await supabase
    .from('body_records')
    .select('recorded_at')
    .eq('user_id', userId)
    .gte('recorded_at', `${yesterday}T00:00:00`)
    .lte('recorded_at', `${yesterday}T23:59:59`)
    .limit(1);

  const { data: member } = await supabase
    .from('team_members')
    .select('streak')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (member) {
    const newStreak = data && data.length > 0 ? (member.streak || 0) + 1 : 1;
    await supabase.from('team_members').update({ streak: newStreak }).eq('user_id', userId);
  }
}

function replyText(event, text) {
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text }],
  });
}

// 建立 Rich Menu
async function setupRichMenu() {
  try {
    try { await client.deleteDefaultRichMenu(); } catch(e) {}

    const richMenu = await client.createRichMenu({
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'fat-loss-menu',
      chatBarText: '📋 功能選單',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: {
            type: 'uri',
            label: '開啟APP',
            uri: 'https://liff.line.me/2010377807-QvlNPosn'
          }
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: {
            type: 'message',
            label: '說明',
            text: '說明'
          }
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: {
            type: 'message',
            label: '今日熱量',
            text: '今日熱量'
          }
        }
      ]
    });

    console.log('Rich Menu ID:', richMenu.richMenuId);
    await client.setDefaultRichMenu(richMenu.richMenuId);
    console.log('Rich Menu 設定完成！');
    return richMenu.richMenuId;
  } catch (error) {
    console.error('Rich Menu 建立失敗:', error);
  }
}

// 推播給所有用戶
async function pushToAllUsers(buildMsg) {
  const { data: users } = await supabase.from('users').select('id');
  if (!users) return;
  for (const user of users) {
    try {
      const msg = await buildMsg(user.id);
      if (msg) await client.pushMessage({ to: user.id, messages: [{ type: 'text', text: msg }] });
    } catch(e) { console.error('推播失敗:', user.id, e.message); }
  }
}

// 每日早上8點提醒
cron.schedule('0 8 * * *', async () => {
  console.log('早晨提醒推播');
  const today = new Date().toISOString().split('T')[0];
  await pushToAllUsers(async (uid) => {
    const { data } = await supabase
      .from('body_records').select('id').eq('user_id', uid)
      .gte('recorded_at', `${today}T00:00:00`).limit(1);
    if (data && data.length > 0) return null; // 已記錄就不打擾
    return '早安！💪 記得記錄今天的體重和體脂\n輸入：體重 XX.X';
  });
}, { timezone: 'Asia/Taipei' });

// 每日晚上9點提醒
cron.schedule('0 21 * * *', async () => {
  console.log('晚間提醒推播');
  const today = new Date().toISOString().split('T')[0];
  await pushToAllUsers(async (uid) => {
    const { data } = await supabase
      .from('meal_records').select('calories').eq('user_id', uid)
      .gte('recorded_at', `${today}T00:00:00`);
    const total = data ? data.reduce((s, r) => s + r.calories, 0) : 0;
    if (total === 0) return '晚上好！🌙 今天還沒有飲食記錄\n輸入：早餐/午餐/晚餐 + 食物名稱';
    
    const { data: memberData } = await supabase
      .from('team_members').select('calorie_goal').eq('user_id', uid)
      .order('created_at', { ascending: false }).limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - total;
    if (remaining > 0) {
      return `🌙 今日飲食回顧\n已攝取 ${total} kcal，還剩 ${remaining} kcal\n繼續保持！💪`;
    } else {
      return `🌙 今日飲食回顧\n已攝取 ${total} kcal，超標 ${Math.abs(remaining)} kcal\n明天繼續加油！`;
    }
  });
}, { timezone: 'Asia/Taipei' });

// 每週一早上9點週報
cron.schedule('0 9 * * 1', async () => {
  console.log('週報推播');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 查所有隊伍
  const { data: teams } = await supabase.from('teams').select('id, name');
  if (!teams) return;

  for (const team of teams) {
    const { data: members } = await supabase
      .from('team_members').select('user_id, streak').eq('team_id', team.id);
    if (!members || members.length === 0) continue;

    const memberIds = members.map(m => m.user_id);
    const { data: userInfos } = await supabase
      .from('users').select('id, display_name').in('id', memberIds);
    const { data: bodyData } = await supabase
      .from('body_records').select('user_id, weight, body_fat, recorded_at')
      .in('user_id', memberIds).gte('recorded_at', weekAgo)
      .order('recorded_at', { ascending: false });

    const nameByUser = {};
    for (const u of (userInfos || [])) nameByUser[u.id] = u.display_name || '隊友';
    const streakByUser = {};
    for (const m of members) streakByUser[m.user_id] = m.streak || 0;
    const latestByUser = {};
    for (const r of (bodyData || [])) {
      if (!latestByUser[r.user_id]) latestByUser[r.user_id] = r;
    }

    // 以 streak 排名
    const ranked = [...memberIds].sort((a, b) => (streakByUser[b] || 0) - (streakByUser[a] || 0));
    const medals = ['🥇', '🥈', '🥉'];

    let msg = `📊 ${team.name} 本週週報\n` + '═'.repeat(18) + '\n\n';
    ranked.forEach((uid, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const name = nameByUser[uid] || '隊友';
      const streak = streakByUser[uid] || 0;
      const rec = latestByUser[uid];
      msg += `${medal} ${name}  🔥${streak}天\n`;
      if (rec?.weight) msg += `   體重 ${rec.weight}kg`;
      if (rec?.body_fat) msg += `  體脂 ${rec.body_fat}%`;
      msg += '\n';
    });
    msg += '\n繼續加油！下週見 💪';

    // 推播給所有隊員
    for (const uid of memberIds) {
      try {
        await client.pushMessage({ to: uid, messages: [{ type: 'text', text: msg }] });
      } catch(e) { console.error('週報推播失敗:', uid, e.message); }
    }
  }
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setupRichMenu();
});
