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
    return replyText(event, `🏋️ 減脂挑戰指令說明\n\n📊 身體數據記錄\n體重 62.5 → 記錄體重\n體脂 21.3 → 記錄體脂\n飲水 500 → 記錄飲水(ml)\n\n🍱 飲食記錄\n早餐 雞胸飯 → 搜尋食物\n午餐 便當 500 → 直接記錄卡路里\n晚餐 地瓜 200 → 同上\n點心 水果 100 → 同上\n\n📈 查詢\n今日熱量 → 查看今日飲食\n我的進度 → 查看本週進度\n\n💪 開啟APP\n👉 https://liff.line.me/2010377807-QvlNPosn`);
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
          ? `${foodName} ${grams}克的卡路里是多少？只回傳數字，不要任何說明。`
          : `${foodName} 一般份量（約100-200克）的卡路里是多少？只回傳數字，不要任何說明。`;

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

    return replyText(event, `✅ ${mealType}已記錄\n${calNote}`);
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

// 每日早上8點提醒
cron.schedule('0 8 * * *', async () => {
  console.log('早晨提醒推播');
}, { timezone: 'Asia/Taipei' });

// 每日晚上9點提醒
cron.schedule('0 21 * * *', async () => {
  console.log('晚間提醒推播');
}, { timezone: 'Asia/Taipei' });

// 每週一早上9點週報
cron.schedule('0 9 * * 1', async () => {
  console.log('週報推播');
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setupRichMenu();
});
