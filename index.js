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
    } else if (event.type === 'message' && event.message.type === 'image') {
      await handleImageMessage(event);
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
      text: `歡迎加入減脂挑戰！🏋️\n\n先來設定你的目標吧 👇`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '減脂 1200kcal/天', text: '設定熱量目標 1200' } },
          { type: 'action', action: { type: 'message', label: '輕鬆 1500kcal/天', text: '設定熱量目標 1500' } },
          { type: 'action', action: { type: 'message', label: '維持 1800kcal/天', text: '設定熱量目標 1800' } },
          { type: 'action', action: { type: 'message', label: '自訂目標', text: '設定熱量目標' } },
        ]
      }
    }],
  });
}

// 暫存用戶等待選餐別的狀態
const pendingImageMeal = {};

async function handleImageMessage(event) {
  const userId = event.source.userId;
  const messageId = event.message.id;

  try {
    // 下載圖片（相容新版 LINE SDK）
    const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const arrayBuffer = await response.arrayBuffer();
    const imageBase64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/jpeg';

    // 呼叫 Gemini Vision 辨識食物
    const geminiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout:free',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: '這張圖片裡有什麼食物？請用繁體中文列出所有食物和估算的總卡路里。格式只能是這兩行：\n食物：XXX、XXX\n卡路里：數字\n不要其他任何說明或單位文字。' }
          ]
        }]
      }),
    });

    const geminiData = await geminiRes.json();
    console.log('Vision 完整回應:', JSON.stringify(geminiData).substring(0, 500));
    const aiText = geminiData.choices?.[0]?.message?.content?.trim() || '';
    console.log('Vision aiText:', aiText);

    if (!aiText) {
      return replyText(event, '無法辨識圖片\n請直接輸入文字記錄\n例：午餐 雞腿便當');
    }

    // 解析卡路里
    const calMatch = aiText.match(/卡路里[：:]\s*(\d+)/);
    const estimatedCal = calMatch ? parseInt(calMatch[1]) : null;
    const foodMatch = aiText.match(/食物[：:]\s*(.+)/);
    const foodDesc = foodMatch ? foodMatch[1].trim() : '食物';

    if (!estimatedCal) {
      return replyText(event, `辨識結果：\n${aiText}\n\n請手動記錄：\n午餐 食物名稱 卡路里`);
    }

    // 暫存辨識結果，等用戶選餐別
    pendingImageMeal[userId] = { foodDesc, estimatedCal, expiry: Date.now() + 60000 };

    // 用 Quick Reply 讓用戶選餐別
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `🔍 辨識結果：\n${foodDesc}\n估算：${estimatedCal} kcal\n\n這是哪一餐？`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '🌅 早餐', text: '記錄圖片 早餐' } },
            { type: 'action', action: { type: 'message', label: '☀️ 午餐', text: '記錄圖片 午餐' } },
            { type: 'action', action: { type: 'message', label: '🌙 晚餐', text: '記錄圖片 晚餐' } },
            { type: 'action', action: { type: 'message', label: '🍎 點心', text: '記錄圖片 點心' } },
          ]
        }
      }]
    });

  } catch (e) {
    console.error('圖片辨識失敗:', e.message, e.stack);
    return replyText(event, `圖片辨識失敗：${e.message}\n請直接輸入文字記錄\n例：午餐 雞腿便當 650`);
  }
}

async function handleMessage(event) {
  const userId = event.source.userId;
  // 正規化：全形空格→半形、多空格→單一空格
  const text = event.message.text.replace(/[　 ]/g, ' ').replace(/\s+/g, ' ').trim();


  // 處理圖片辨識後選餐別
  const imgMealMatch = text.match(/^記錄圖片\s*(早餐|午餐|晚餐|點心)$/);
  if (imgMealMatch) {
    const mealType = imgMealMatch[1];
    const pending = pendingImageMeal[userId];
    if (!pending || Date.now() > pending.expiry) {
      return replyText(event, '辨識結果已過期，請重新傳送食物照片');
    }
    delete pendingImageMeal[userId];
    const { foodDesc, estimatedCal } = pending;
    await supabase.from('meal_records').insert({
      user_id: userId, team_id: null, meal_type: mealType,
      food_name: foodDesc, calories: estimatedCal,
    });
    const today = new Date().toISOString().split('T')[0];
    const { data: todayMeals } = await supabase.from('meal_records').select('calories')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const todayTotal = todayMeals ? todayMeals.reduce((s, r) => s + r.calories, 0) : estimatedCal;
    const { data: memberData } = await supabase.from('team_members').select('calorie_goal')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - todayTotal;
    const summaryMsg = remaining > 0
      ? `📊 今日 ${todayTotal} kcal／目標 ${goal} kcal\n還剩 ${remaining} kcal 可以吃`
      : `📊 今日 ${todayTotal} kcal／目標 ${goal} kcal\n⚠️ 已超標 ${Math.abs(remaining)} kcal`;
    return replyText(event, `✅ ${mealType}已記錄\n${foodDesc} → ${estimatedCal} kcal\n\n${summaryMsg}`);
  }

  await supabase.from('users').upsert({ id: userId });

  // 說明指令
  if (text === '說明' || text === 'help' || text === '?') {
    return replyText(event, `🏋️ 減脂挑戰指令說明\n\n📊 身體數據記錄\n體重 62.5 → 記錄體重\n體脂 21.3 → 記錄體脂\n飲水 500 → 記錄飲水(ml)\n\n🍱 飲食記錄\n早餐 雞胸飯 → 搜尋食物\n午餐 便當 500 → 直接記錄卡路里\n晚餐 地瓜 200 → 同上\n點心 水果 100 → 同上\n\n📈 查詢\n今日熱量 → 查看今日飲食\n我的進度 → 查看本週進度\n隊伍進度 → 查看隊友排行\n\n⚙️ 設定\n設定熱量目標 → 設定每日卡路里\n邀請好友 → 產生邀請訊息\\n加入 邀請碼 → 加入隊伍\\n退出隊伍 → 離開目前隊伍\n刪除早餐/午餐/晚餐/點心 → 刪除今日最新\n刪除體重/體脂/飲水 → 刪除今日最新\n\n💪 開啟APP\n👉 https://liff.line.me/2010377807-QvlNPosn`);
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

    // 輔助函式：查單一食物卡路里
    async function lookupCalories(name, g) {
      const { data: foods } = await supabase
        .from('food_database').select('*').ilike('name', `%${name}%`).limit(1);
      if (foods && foods.length > 0) {
        const cal = Math.round(foods[0].calories_per_100g * (g || 100) / 100);
        return { cal, label: g ? `${foods[0].name} ${g}g→${cal}kcal` : `${foods[0].name} 100g→${cal}kcal` };
      }
      // AI 估算
      const prompt = g
        ? `台灣食物「${name}」${g}克的卡路里是多少？只回傳數字。`
        : `台灣食物或飲料「${name}」一般份量的卡路里是多少？只回傳數字。`;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'meta-llama/llama-4-scout:free', messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      const num = parseInt((d.choices?.[0]?.message?.content || '').replace(/[^0-9]/g, ''));
      if (num > 0 && num < 5000) {
        return { cal: num, label: g ? `${name} ${g}g→${num}kcal(AI)` : `${name}→${num}kcal(AI)` };
      }
      return null;
    }

    let calories, calNote;

    if (directCal) {
      calories = directCal;
      calNote = `${foodName} ${directCal} kcal`;
    } else {
      // 判斷是否為多食物輸入（含有多個克數標記或空格分隔多項食物）
      const hasMultiple = (rawInput.match(/(\d+)(克|g|公克)/gi) || []).length > 1 ||
                          rawInput.includes('半顆') || rawInput.includes('半碗') || rawInput.includes('半份');

      if (hasMultiple || (!grams && !gramInNameMatch && rawInput.split(/\s+/).length > 2)) {
        // 多食物模式：交給 AI 直接算
        const multiPrompt = `以下是一餐的食物清單，請計算每項食物的卡路里後加總。\n食物：${rawInput}\n\n請用以下格式回答（每行一項）：\n食物名 份量 → 卡路里kcal\n...\n合計：總卡路里kcal\n\n注意：最後一行必須是「合計：數字kcal」格式。`;
        const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
          body: JSON.stringify({ model: 'meta-llama/llama-4-scout:free', messages: [{ role: 'user', content: multiPrompt }] }),
        });
        const aiData = await aiRes.json();
        const aiText = aiData.choices?.[0]?.message?.content?.trim() || '';
        console.log('多食物 AI 回應:', aiText);
        const totalMatch = aiText.match(/合計[：:]\s*(\d+)/);
        if (totalMatch) {
          calories = parseInt(totalMatch[1]);
          calNote = aiText.replace(/合計[：:]\s*\d+kcal/g, '').trim() + `\n合計 ${calories} kcal`;
          foodName = rawInput;
        } else {
          return replyText(event, `無法計算卡路里\n請改用：${mealType} 食物名稱 [卡路里數字]`);
        }
      } else {
        // 單一食物
        const result = await lookupCalories(foodName, grams);
        if (!result) {
          return replyText(event, `找不到「${foodName}」的熱量資料\n請改用：${mealType} ${foodName} [卡路里數字]\n例：${mealType} ${foodName} 300`);
        }
        calories = result.cal;
        calNote = result.label;
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
      .not('team_id', 'is', null)
      .order('joined_at', { ascending: false })
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

  // 設定熱量目標
  const goalMatch = text.match(/^設定熱量目標\s*(\d+)?$/);
  if (goalMatch) {
    const kcal = goalMatch[1] ? parseInt(goalMatch[1]) : null;
    if (!kcal) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: '請選擇你的每日熱量目標：',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '1200 kcal（積極減脂）', text: '設定熱量目標 1200' } },
              { type: 'action', action: { type: 'message', label: '1500 kcal（穩定減脂）', text: '設定熱量目標 1500' } },
              { type: 'action', action: { type: 'message', label: '1800 kcal（輕鬆維持）', text: '設定熱量目標 1800' } },
              { type: 'action', action: { type: 'message', label: '2000 kcal（緩慢調整）', text: '設定熱量目標 2000' } },
            ]
          }
        }]
      });
    }
    // 更新或建立 team_members 記錄
    const { data: existing } = await supabase
      .from('team_members').select('id').eq('user_id', userId).limit(1);
    if (existing && existing.length > 0) {
      await supabase.from('team_members').update({ calorie_goal: kcal }).eq('user_id', userId);
    } else {
      await supabase.from('team_members').insert({ user_id: userId, calorie_goal: kcal });
    }
    return replyText(event, `✅ 每日熱量目標設為 ${kcal} kcal\n\n現在可以開始記錄飲食了！\n傳送「說明」查看所有指令`);
  }

  // 邀請好友
  if (text === '邀請好友') {
    const { data: myTeam } = await supabase
      .from('team_members').select('team_id, teams(name, invite_code)')
      .eq('user_id', userId).not('team_id', 'is', null)
      .order('joined_at', { ascending: false }).limit(1).maybeSingle();
    if (!myTeam?.teams) return replyText(event, '你還沒有加入任何隊伍\n請先建立或加入隊伍');
    const { name, invite_code } = myTeam.teams;
    const msg = `🏋️ 邀請你加入「${name}」減脂挑戰！\n\n加入方式：\n1️⃣ 加這個 Bot：https://line.me/R/ti/p/@254dtuqa\n2️⃣ 傳送指令：加入 ${invite_code}\n\n或直接開啟 APP：\nhttps://liff.line.me/2010377807-QvlNPosn\n\n一起加油！💪`;
    return replyText(event, msg);
  }

  // 退出隊伍
  if (text === '退出隊伍') {
    const { data: myTeam } = await supabase
      .from('team_members').select('team_id, teams(name)')
      .eq('user_id', userId).not('team_id', 'is', null).order('joined_at', { ascending: false }).limit(1).maybeSingle();
    if (!myTeam) return replyText(event, '你目前沒有加入任何隊伍');
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `確定要退出「${myTeam.teams?.name || '隊伍'}」嗎？`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '✅ 確定退出', text: '確定退出隊伍' } },
            { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
          ]
        }
      }]
    });
  }

  if (text === '確定退出隊伍') {
    const { data: myTeam } = await supabase
      .from('team_members').select('id, team_id, teams(name)')
      .eq('user_id', userId).not('team_id', 'is', null).order('joined_at', { ascending: false }).limit(1).maybeSingle();
    if (!myTeam) return replyText(event, '你目前沒有加入任何隊伍');
    await supabase.from('team_members').delete().eq('id', myTeam.id);
    return replyText(event, `✅ 已退出「${myTeam.teams?.name || '隊伍'}」\n掰掰！繼續加油 💪`);
  }

  // 刪除最新記錄
  const deleteMatch = text.match(/^刪除(早餐|午餐|晚餐|點心|體重|體脂|飲水)$/);
  if (deleteMatch) {
    const type = deleteMatch[1];
    const isMeal = ['早餐', '午餐', '晚餐', '點心'].includes(type);
    const isBody = ['體重', '體脂', '飲水'].includes(type);
    const today = new Date().toISOString().split('T')[0];

    if (isMeal) {
      const { data } = await supabase.from('meal_records').select('id, food_name, calories')
        .eq('user_id', userId).eq('meal_type', type)
        .gte('recorded_at', `${today}T00:00:00`)
        .order('recorded_at', { ascending: false }).limit(1);
      if (!data || data.length === 0) return replyText(event, `今天沒有${type}記錄`);
      await supabase.from('meal_records').delete().eq('id', data[0].id);
      return replyText(event, `🗑️ 已刪除${type}：${data[0].food_name} ${data[0].calories} kcal`);
    }

    if (isBody) {
      const colMap = { 體重: 'weight', 體脂: 'body_fat', 飲水: 'water_ml' };
      const { data } = await supabase.from('body_records').select('id, weight, body_fat, water_ml')
        .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`)
        .order('recorded_at', { ascending: false }).limit(1);
      if (!data || data.length === 0) return replyText(event, `今天沒有${type}記錄`);
      await supabase.from('body_records').delete().eq('id', data[0].id);
      const val = data[0][colMap[type]];
      return replyText(event, `🗑️ 已刪除${type}記錄：${val}`);
    }
  }

  if (text === '取消') {
    return replyText(event, '已取消 👌');
  }

  // 加入隊伍（Bot 指令：加入 7556d6ff）
  const joinMatch = text.match(/^加入\s+([a-f0-9]{8})$/i);
  if (joinMatch) {
    const code = joinMatch[1].toLowerCase();
    const { data: team } = await supabase.from('teams').select('*').eq('invite_code', code).maybeSingle();
    if (!team) return replyText(event, `找不到邀請碼「${code}」\n請確認邀請碼是否正確`);

    // 檢查是否已加入
    const { data: existing } = await supabase.from('team_members')
      .select('id').eq('team_id', team.id).eq('user_id', userId).maybeSingle();
    if (existing) return replyText(event, `你已經是「${team.name}」的成員了！`);

    await supabase.from('team_members').insert({ team_id: team.id, user_id: userId });

    // 通知其他隊員
    const { data: members } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
    const { data: userInfo } = await supabase.from('users').select('display_name').eq('id', userId).maybeSingle();
    const name = userInfo?.display_name || '新成員';
    for (const m of (members || [])) {
      if (m.user_id !== userId) {
        try {
          await client.pushMessage({ to: m.user_id, messages: [{ type: 'text', text: `🎉 ${name} 加入了「${team.name}」！` }] });
        } catch(e) {}
      }
    }
    return replyText(event, `✅ 成功加入「${team.name}」！\n\n輸入「隊伍進度」查看隊友狀況\n一起加油 💪`);
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
