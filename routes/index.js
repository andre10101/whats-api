var express = require('express');
var router = express.Router();
const { Client } = require('../index');


var mysql = require('mysql');

var con = mysql.createConnection({
  host: "179.188.38.36",
  user: "andre.seremeta",
  password: "AtriaABC28*Andre",
  port: 3306,
  database: "praweb"
});


function checkAuthTokenMiddleware(req, res, next) {
  if (req.headers && req.headers.token) {
    let token = req.headers.token;
    if (token === undefined) {
      // access token - missing
      return next(new Error("Authorization header required."));
    } else if (token == "d76e45028a10cfba523b17118f99e2e3") {
      return next();
    } else {
      return next(new Error("Token invalid."));
    }
    // add something here to ensure the token is valid
  } else {
    return next(new Error("Authorization header required."));
  }
}

/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Express' });
});


router.get("/whats/:num", checkAuthTokenMiddleware, async function (req, res) {
  var client = new Client({ puppeteer: { headless: false } });
  var send_by = req.params.num;

  try {

    let ready = await client.initialize(send_by);
    
    if (!ready) {
      await client.destroy();
      return res.status(200).json({ msg: "Não foi possivel registrar o celular." });
    }
    if(client) await client.destroy();
    return res.status(200).json({ msg: "Esta pronto pra ser usado." });

  } catch (e) {
    await client.destroy();
    console.log("error", e)
    return res.status(400);
  }
})


router.post("/whats", checkAuthTokenMiddleware, async function (req, res) {
  var client = new Client({ puppeteer: { headless: false } });
  var send_by = req.body.send_by;
  var send_to = req.body.send_to;
  var msg = req.body.msg;

  var msg = req.body.msg;

  try {

      console.log("se", send_by)
      let ready = await client.verifyQrCode(send_by);

      console.log("read", ready)
      if (ready) {

          await client.initialize(send_by);
          let numero = send_to + "@c.us";

          let message = await client.sendMessage(numero, msg)

          if (!message) {
              return res.status(200).json({ msg: "Erro ao enviar a mensagem" });
          }

          return setTimeout(async function () {
              await client.destroy();
              res.status(200)
                  .json({ msg: "enviando Mensagem via whatsapp.." });
          }, 3000);

      } else {
          return res.status(200).json({ msg: "Não esta pronto pra ser usado" });
      }
  } catch (e) {
      console.log("error", e)
      return res.status(400);
  }
});


module.exports = router;
