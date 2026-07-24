const express = require('express');
console.log('=== BOT VERSION: gemini-2.5-flash ===');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
app.get('/', (req, res) => {
  res.send('OK');
});

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
        model: 'google/gemini-2.5-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: '這張圖片裡有什麼食物？請用繁體中文列出所有食物和估算的總卡路里與蛋白質。格式只能是這三行：\n食物：XXX、XXX\n卡路里：數字\n蛋白質：數字\n不要其他任何說明或單位文字。' }
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

    // 解析卡路里＋蛋白質
    const calMatch = aiText.match(/卡路里[：:]\s*(\d+)/);
    const estimatedCal = calMatch ? parseInt(calMatch[1]) : null;
    const proteinMatch = aiText.match(/蛋白質[：:]\s*([\d.]+)/);
    const estimatedProtein = proteinMatch ? parseFloat(proteinMatch[1]) : 0;
    const foodMatch = aiText.match(/食物[：:]\s*(.+)/);
    const foodDesc = foodMatch ? foodMatch[1].trim() : '食物';

    if (!estimatedCal) {
      return replyText(event, `辨識結果：\n${aiText}\n\n請手動記錄：\n午餐 食物名稱 卡路里`);
    }

    // 暫存辨識結果，等用戶選餐別
    pendingImageMeal[userId] = { foodDesc, estimatedCal, estimatedProtein, expiry: Date.now() + 60000 };

    // 用 Quick Reply 讓用戶選餐別
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `🔍 辨識結果：\n${foodDesc}\n估算：${estimatedCal} kcal／蛋白質 ${estimatedProtein}g\n\n這是哪一餐？`,
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
  const text = event.message.text.replace(/[　 ]/g, ' ').replace(/\s+/g, ' ').trim();


  // 處理圖片辨識後選餐別
  const imgMealMatch = text.match(/^記錄圖片\s*(早餐|午餐|晚餐|點心)$/);
  if (imgMealMatch) {
    const mealType = imgMealMatch[1];
    const pending = pendingImageMeal[userId];
    if (!pending || Date.now() > pending.expiry) {
      return replyText(event, '辨識結果已過期，請重新傳送食物照片');
    }
    delete pendingImageMeal[userId];
    const { foodDesc, estimatedCal, estimatedProtein } = pending;
    await supabase.from('meal_records').insert({
      user_id: userId, team_id: null, meal_type: mealType,
      food_name: foodDesc, calories: estimatedCal, protein: estimatedProtein || 0,
    });
    const today = new Date().toISOString().split('T')[0];
    const { data: todayMeals } = await supabase.from('meal_records').select('calories, protein')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const todayTotal = todayMeals ? todayMeals.reduce((s, r) => s + r.calories, 0) : estimatedCal;
    const todayProtein = todayMeals ? todayMeals.reduce((s, r) => s + (r.protein || 0), 0) : (estimatedProtein || 0);
    const { data: todayExercise } = await supabase.from('exercise_records').select('calories_burned')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const todayBurned = todayExercise ? todayExercise.reduce((s, r) => s + (r.calories_burned || 0), 0) : 0;
    const { data: memberData } = await supabase.from('team_members').select('calorie_goal')
      .eq('user_id', userId).order('joined_at', { ascending: false }).limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - todayTotal;
    const burnedLine = todayBurned > 0 ? `\n🔥 今日運動消耗 ${todayBurned} kcal（另計，不影響上方額度）` : '';
    const summaryMsg = remaining > 0
      ? `📊 今日攝取 ${todayTotal} kcal／目標 ${goal} kcal\n還剩 ${remaining} kcal 可以吃\n💪 蛋白質 ${todayProtein.toFixed(1)}g${burnedLine}`
      : `📊 今日攝取 ${todayTotal} kcal／目標 ${goal} kcal\n⚠️ 已超標 ${Math.abs(remaining)} kcal\n💪 蛋白質 ${todayProtein.toFixed(1)}g${burnedLine}`;
    return replyText(event, `✅ ${mealType}已記錄\n${foodDesc} → ${estimatedCal} kcal／蛋白質 ${estimatedProtein || 0}g\n\n${summaryMsg}`);
  }

  await supabase.from('users').upsert({ id: userId });

  // 說明指令
  if (text === '說明' || text === 'help' || text === '?') {
    return replyText(event, `🏋️ 減脂挑戰指令說明\n\n📊 身體數據記錄\n體重 62.5 → 記錄體重\n體脂 21.3 → 記錄體脂\n飲水 500 → 記錄飲水(ml)\n睡眠 7.5 → 記錄睡眠時數\n運動 跑步 30分鐘 → AI估算消耗熱量\n\n🍱 飲食記錄\n早餐 雞胸肉 → AI估算卡路里+蛋白質\n午餐 便當 500 → 直接記錄卡路里\n點心 雞胸肉150克 → 指定克數\n傳食物照片 → 自動辨識\n\n📈 查詢\n今日熱量 → 今日飲食+運動+蛋白質總計\n我的進度 → 本週體重體脂\n隊伍進度 → 隊友排行\n\n⚙️ 設定\n設定熱量目標 → 每日卡路里上限\n邀請好友 → 產生邀請連結\n加入 邀請碼 → 加入隊伍\n退出隊伍 → 離開隊伍\n刪除早餐/午餐/晚餐/點心 → 刪除今日最新\n刪除體重/體脂/飲水/睡眠/運動 → 刪除今日最新\n\n💪 開啟APP\n👉 https://liff.line.me/2010377807-QvlNPosn`);
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

  // 睡眠記錄
  if (text.startsWith('睡眠')) {
    const hours = parseFloat(text.replace('睡眠', '').trim());
    if (isNaN(hours) || hours <= 0 || hours > 24) return replyText(event, '格式錯誤，請輸入：睡眠 7.5');
    await supabase.from('sleep_records').insert({ user_id: userId, hours });
    let msg = `😴 睡眠已記錄：${hours} 小時`;
    if (hours < 6) msg += `\n💡 睡眠有點不足，試著早點休息～`;
    else if (hours >= 7 && hours <= 9) msg += `\n✅ 睡眠時數很理想！`;
    return replyText(event, msg);
  }

  // 運動記錄：運動 跑步 30分鐘
  const exerciseMatch = text.match(/^運動\s+(.+?)\s*(\d+)\s*分(?:鐘)?$/);
  if (exerciseMatch) {
    const exerciseType = exerciseMatch[1].trim();
    const duration = parseInt(exerciseMatch[2]);

    // 取最新體重，讓 AI 估算更準確
    const { data: latestBody } = await supabase.from('body_records')
      .select('weight').eq('user_id', userId).not('weight', 'is', null)
      .order('recorded_at', { ascending: false }).limit(1);
    const weight = latestBody?.[0]?.weight;

    const prompt = weight
      ? `一位體重${weight}公斤的人，進行「${exerciseType}」運動${duration}分鐘，估算消耗的卡路里。只回傳以下格式一行，不要其他說明：\n消耗：數字`
      : `一般成人進行「${exerciseType}」運動${duration}分鐘，估算消耗的卡路里。只回傳以下格式一行，不要其他說明：\n消耗：數字`;

    let caloriesBurned = 0;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      const content = d.choices?.[0]?.message?.content || '';
      const burnMatch = content.match(/消耗[：:]\s*(\d+)/);
      caloriesBurned = burnMatch ? parseInt(burnMatch[1]) : 0;
    } catch (e) {
      console.error('運動熱量估算失敗:', e.message);
    }
    if (!caloriesBurned) caloriesBurned = Math.round(duration * 5); // AI失敗時的粗估備援

    await supabase.from('exercise_records').insert({
      user_id: userId,
      exercise_type: exerciseType,
      duration_minutes: duration,
      calories_burned: caloriesBurned,
    });

    const today = new Date().toISOString().split('T')[0];
    const { data: todayExercise } = await supabase.from('exercise_records').select('calories_burned')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const totalBurned = todayExercise ? todayExercise.reduce((s, r) => s + (r.calories_burned || 0), 0) : caloriesBurned;

    const { data: todayMeals } = await supabase.from('meal_records').select('calories')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const todayEaten = todayMeals ? todayMeals.reduce((s, r) => s + r.calories, 0) : 0;

    const { data: memberData } = await supabase.from('team_members').select('calorie_goal')
      .eq('user_id', userId).order('joined_at', { ascending: false }).limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - todayEaten;

    return replyText(event, `🏃 運動已記錄：${exerciseType} ${duration}分鐘\n🔥 估算消耗 ${caloriesBurned} kcal（今日累計消耗 ${totalBurned} kcal）\n\n📊 今日飲食 ${todayEaten} kcal／目標 ${goal} kcal\n還可以吃 ${remaining} kcal`);
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

    // 輔助函式：用 AI 估算單一食物卡路里＋蛋白質
    async function lookupCalories(name, g) {
      const prompt = g
        ? `台灣食物「${name}」${g}克的營養資訊。只回傳以下格式兩行，不要其他說明：\n卡路里：數字\n蛋白質：數字`
        : `台灣常見食物或飲料「${name}」一般份量（飲料一杯、食物一份）的營養資訊。只回傳以下格式兩行，不要其他說明：\n卡路里：數字\n蛋白質：數字`;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      console.log('OpenRouter 回應:', JSON.stringify(d).substring(0, 500));
      const content = d.choices?.[0]?.message?.content || '';
      const calMatch = content.match(/卡路里[：:]\s*(\d+)/);
      const proteinMatch = content.match(/蛋白質[：:]\s*([\d.]+)/);
      const cal = calMatch ? parseInt(calMatch[1]) : 0;
      const protein = proteinMatch ? parseFloat(proteinMatch[1]) : 0;
      if (cal > 0 && cal < 5000) {
        const label = g ? `${name} ${g}g → ${cal} kcal／蛋白質 ${protein}g` : `${name} → ${cal} kcal／蛋白質 ${protein}g`;
        return { cal, protein, label };
      }
      return null;
    }

    let calories, calNote, proteinTotal = 0;

    if (directCal) {
      calories = directCal;
      calNote = `${foodName} ${directCal} kcal`;
      proteinTotal = 0;
    } else {
      // 判斷是否為多食物輸入（含有多個克數標記或空格分隔多項食物）
      const hasMultiple = (rawInput.match(/(\d+)(克|g|公克)/gi) || []).length > 1 ||
                          rawInput.includes('半顆') || rawInput.includes('半碗') || rawInput.includes('半份');

      if (hasMultiple || (!grams && !gramInNameMatch && rawInput.split(/\s+/).length > 2)) {
        // 多食物模式：交給 AI 直接算
        const multiPrompt = `以下是一餐的食物清單，請計算每項食物的卡路里和蛋白質後加總。\n食物：${rawInput}\n\n請用以下格式回答（每行一項）：\n食物名 份量 → 卡路里kcal 蛋白質Xg\n...\n合計：總卡路里kcal 蛋白質總克數g\n\n注意：最後一行必須是「合計：數字kcal 蛋白質數字g」格式。`;
        const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
          body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: multiPrompt }] }),
        });
        const aiData = await aiRes.json();
        const aiText = aiData.choices?.[0]?.message?.content?.trim() || '';
        console.log('多食物 AI 回應:', aiText);
        const totalMatch = aiText.match(/合計[：:]\s*(\d+)kcal\s*蛋白質\s*([\d.]+)g/);
        const calOnlyMatch = aiText.match(/合計[：:]\s*(\d+)/);
        if (totalMatch) {
          calories = parseInt(totalMatch[1]);
          proteinTotal = parseFloat(totalMatch[2]);
          calNote = aiText.replace(/合計[：:].*$/m, '').trim() + `\n合計 ${calories} kcal／蛋白質 ${proteinTotal}g`;
          foodName = rawInput;
        } else if (calOnlyMatch) {
          calories = parseInt(calOnlyMatch[1]);
          proteinTotal = 0;
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
        proteinTotal = result.protein || 0;
      }
    }

    await supabase.from('meal_records').insert({
      user_id: userId,
      team_id: null,
      meal_type: mealType,
      food_name: foodName,
      calories,
      protein: proteinTotal || 0,
    });

    // 查今日總卡路里＋蛋白質
    const today = new Date().toISOString().split('T')[0];
    const { data: todayMeals } = await supabase
      .from('meal_records')
      .select('calories, protein')
      .eq('user_id', userId)
      .gte('recorded_at', `${today}T00:00:00`);
    const todayTotal = todayMeals ? todayMeals.reduce((s, r) => s + r.calories, 0) : calories;
    const todayProtein = todayMeals ? todayMeals.reduce((s, r) => s + (r.protein || 0), 0) : (proteinTotal || 0);

    // 查今日運動消耗
    const { data: todayExercise } = await supabase.from('exercise_records').select('calories_burned')
      .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`);
    const todayBurned = todayExercise ? todayExercise.reduce((s, r) => s + (r.calories_burned || 0), 0) : 0;

    // 查用戶目標熱量
    const { data: memberData } = await supabase
      .from('team_members')
      .select('calorie_goal')
      .eq('user_id', userId)
      .order('joined_at', { ascending: false })
      .limit(1);
    const goal = memberData?.[0]?.calorie_goal || 1500;
    const remaining = goal - todayTotal;
    const burnedLine = todayBurned > 0 ? `\n🔥 今日運動消耗 ${todayBurned} kcal（另計，不影響上方額度）` : '';

    let summaryMsg;
    if (remaining > 0) {
      summaryMsg = `📊 今日攝取 ${todayTotal} kcal／目標 ${goal} kcal\n還剩 ${remaining} kcal 可以吃\n💪 蛋白質 ${todayProtein.toFixed(1)}g${burnedLine}`;
    } else {
      summaryMsg = `📊 今日攝取 ${todayTotal} kcal／目標 ${goal} kcal\n⚠️ 已超標 ${Math.abs(remaining)} kcal\n💪 蛋白質 ${todayProtein.toFixed(1)}g${burnedLine}`;
    }

    return replyText(event, `✅ ${mealType}已記錄\n${calNote}\n\n${summaryMsg}`);
  }

  // 今日熱量
  if (text === '今日熱量') {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('meal_records')
      .select('calories, protein, meal_type, food_name')
      .eq('user_id', userId)
      .gte('recorded_at', `${today}T00:00:00`)
      .lte('recorded_at', `${today}T23:59:59`);
    const { data: exerciseData } = await supabase
      .from('exercise_records')
      .select('calories_burned')
      .eq('user_id', userId)
      .gte('recorded_at', `${today}T00:00:00`)
      .lte('recorded_at', `${today}T23:59:59`);

    if ((!data || data.length === 0) && (!exerciseData || exerciseData.length === 0)) return replyText(event, '今天還沒有飲食記錄 🍽️');
    const total = data ? data.reduce((sum, r) => sum + r.calories, 0) : 0;
    const totalProtein = data ? data.reduce((sum, r) => sum + (r.protein || 0), 0) : 0;
    const totalBurned = exerciseData ? exerciseData.reduce((sum, r) => sum + (r.calories_burned || 0), 0) : 0;
    const list = data && data.length > 0 ? data.map(r => `${r.meal_type} ${r.food_name} ${r.calories}kcal／蛋白質${r.protein || 0}g`).join('\n') : '（今天還沒有飲食記錄）';
    let msg = `📊 今日飲食：\n${list}\n\n總攝取：${total} kcal\n💪 蛋白質：${totalProtein.toFixed(1)}g`;
    if (totalBurned > 0) msg += `\n\n🔥 運動消耗：${totalBurned} kcal（另計）`;
    return replyText(event, msg);
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
  const deleteMatch = text.match(/^刪除(早餐|午餐|晚餐|點心|體重|體脂|飲水|睡眠|運動)$/);
  if (deleteMatch) {
    const type = deleteMatch[1];
    const isMeal = ['早餐', '午餐', '晚餐', '點心'].includes(type);
    const isBody = ['體重', '體脂', '飲水'].includes(type);
    const isSleep = type === '睡眠';
    const isExercise = type === '運動';
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

    if (isSleep) {
      const { data } = await supabase.from('sleep_records').select('id, hours')
        .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`)
        .order('recorded_at', { ascending: false }).limit(1);
      if (!data || data.length === 0) return replyText(event, '今天沒有睡眠記錄');
      await supabase.from('sleep_records').delete().eq('id', data[0].id);
      return replyText(event, `🗑️ 已刪除睡眠記錄：${data[0].hours} 小時`);
    }

    if (isExercise) {
      const { data } = await supabase.from('exercise_records').select('id, exercise_type, duration_minutes')
        .eq('user_id', userId).gte('recorded_at', `${today}T00:00:00`)
        .order('recorded_at', { ascending: false }).limit(1);
      if (!data || data.length === 0) return replyText(event, '今天沒有運動記錄');
      await supabase.from('exercise_records').delete().eq('id', data[0].id);
      return replyText(event, `🗑️ 已刪除運動記錄：${data[0].exercise_type} ${data[0].duration_minutes}分鐘`);
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
    if (total === 0) return '晚安！🌙 今天還沒有飲食記錄\n輸入：早餐/午餐/晚餐 + 食物名稱';

    const { data: memberData } = await supabase
      .from('team_members').select('calorie_goal').eq('user_id', uid)
      .order('joined_at', { ascending: false }).limit(1);
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

    let msg = `📊 ${team.name} 本週週報\n${'─'.repeat(20)}\n\n`;
    ranked.forEach((uid, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const name = nameByUser[uid] || '隊友';
      const streak = streakByUser[uid] || 0;
      const rec = latestByUser[uid];
      msg += `${medal} ${name}\n`;
      let stats = `   🔥 連續 ${streak}天`;
      if (rec?.weight) stats += `｜⚖️ ${rec.weight}kg`;
      if (rec?.body_fat) stats += `｜📉 體脂 ${rec.body_fat}%`;
      if (!rec?.weight && !rec?.body_fat) stats += `｜尚未記錄體重`;
      msg += stats + '\n\n';
    });
    msg += `${'─'.repeat(20)}\n繼續加油！下週見 💪`;

    // 推播給所有隊員
    for (const uid of memberIds) {
      try {
        await client.pushMessage({ to: uid, messages: [{ type: 'text', text: msg }] });
      } catch(e) { console.error('週報推播失敗:', uid, e.message); }
    }
  }
}, { timezone: 'Asia/Taipei' });

// 每週日晚上9點：AI 個人週評語與建議
cron.schedule('0 21 * * 0', async () => {
  console.log('AI 週評語推播');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users } = await supabase.from('users').select('id, display_name');
  if (!users) return;

  for (const u of users) {
    try {
      const uid = u.id;
      const { data: bodyData } = await supabase.from('body_records').select('weight, body_fat, recorded_at')
        .eq('user_id', uid).gte('recorded_at', weekAgo).order('recorded_at', { ascending: true });
      const { data: mealData } = await supabase.from('meal_records').select('calories, protein, recorded_at')
        .eq('user_id', uid).gte('recorded_at', weekAgo);
      const { data: sleepData } = await supabase.from('sleep_records').select('hours, recorded_at')
        .eq('user_id', uid).gte('recorded_at', weekAgo);
      const { data: exerciseData } = await supabase.from('exercise_records').select('exercise_type, duration_minutes, calories_burned, recorded_at')
        .eq('user_id', uid).gte('recorded_at', weekAgo);

      const hasData = (bodyData?.length || 0) + (mealData?.length || 0) + (sleepData?.length || 0) + (exerciseData?.length || 0);
      if (hasData === 0) continue; // 這週完全沒記錄就不打擾

      const weightsOnly = (bodyData || []).filter(d => d.weight);
      const weightTrend = weightsOnly.length > 1
        ? `體重從 ${weightsOnly[0].weight}kg 變化到 ${weightsOnly[weightsOnly.length - 1].weight}kg`
        : (weightsOnly.length === 1 ? `本週僅記錄一次體重：${weightsOnly[0].weight}kg` : '本週沒有體重記錄');

      const avgCal = mealData && mealData.length > 0
        ? Math.round(mealData.reduce((s, r) => s + r.calories, 0) / 7)
        : 0;
      const avgProtein = mealData && mealData.length > 0
        ? (mealData.reduce((s, r) => s + (r.protein || 0), 0) / 7).toFixed(1)
        : 0;
      const avgSleep = sleepData && sleepData.length > 0
        ? (sleepData.reduce((s, r) => s + r.hours, 0) / sleepData.length).toFixed(1)
        : null;
      const exerciseCount = exerciseData ? exerciseData.length : 0;
      const totalBurned = exerciseData ? exerciseData.reduce((s, r) => s + (r.calories_burned || 0), 0) : 0;

      const summary = `${weightTrend}\n平均每日攝取熱量：約${avgCal}kcal，平均蛋白質：${avgProtein}g\n睡眠：${avgSleep ? `平均${avgSleep}小時（記錄${sleepData.length}天）` : '本週沒有記錄'}\n運動：本週運動${exerciseCount}次，共消耗約${totalBurned}kcal`;

      const prompt = `你是一位親切但專業的減脂教練。根據以下使用者本週的健康數據，用繁體中文寫一段簡短的評語與建議（3-5句話，語氣鼓勵但誠實，像朋友聊天一樣自然，不要條列）：\n\n${summary}`;

      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      const comment = d.choices?.[0]?.message?.content?.trim();
      if (!comment) continue;

      await client.pushMessage({
        to: uid,
        messages: [{ type: 'text', text: `📝 本週AI評語\n${'─'.repeat(16)}\n\n${comment}` }],
      });
    } catch (e) {
      console.error('AI週評語失敗:', u.id, e.message);
    }
  }
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Rich Menu 請在 LINE Official Account Manager 手動設定
});
