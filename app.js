// app.js
var express = require('express')
var app = express()
var server = require('http').createServer(app)
var io = require('socket.io')(server)

var fs = require("fs")
var path = require("path")

var args = require("minimist")(process.argv.slice(2))

var sessions = []

const TURN_LENGTH = 6000 //cs
const INTERMISSION_LENGTH = 300 //cs
const PORT = args.port || 3000
const HOST = args.host || '127.0.0.1'

// Card generation variables
const EPIC_CARD_CHANCE = 20 // 20%
const RARE_CARD_CHANCE = 30 // 30%
const GIVE_CARD_CHANCE = 30 // 30%
const POSSIBLE_DRINK_DIFFICULTIES = [1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6, 6, 7, 8] // Possible difficulties for drink-cards
const POSSIBLE_GIVE_DIFFICULTIES = [1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 8] // Possible difficulties for give-cards

var intermission_start = null

app.use(function(req, res, next) {
	const fpath = path.join(__dirname + '/public', req.path)
	fs.stat(fpath, function(err, info){
		if (err || info.isDirectory()){
			res.sendFile(path.join(__dirname + '/public', "index.html"))
		} else {
			res.sendFile(fpath)
		}
	})
})

io.on('connection', function(socket){
	socket.on('sessionId', function(data){
		// No path in URL, create new session
		if (!data.sessionId){
			var newSession = createSession()
			socket.emit("connectedToSession", {session: newSession})
		}
		else {
			// Try to connect to existing session
			var existingSession = sessions[findWithCode(sessions, data.sessionId)]
			if (existingSession){
				console.log("Connecting user " + socket.id + " to session :: " + data.sessionId)
				session_addUser(existingSession, socket.id)
			} else {
				console.log("Session does not exist")
			}
		}
	})
	function createSession(){
		var newSession = {
			//id: Math.floor(Math.random() * 1000000000),
			id: Math.floor(Math.random() * 10000), // 4 digits
			users: [],
			state: "lobby",
			rounds: []
		}
		console.log("New session created :: " + newSession.id)
		session_addUser(newSession, socket.id)
		newSession.users[0].master = true;
		sessions.push(newSession)
		return newSession;
	}
	function session_addUser(session, userId){
		console.log("New user: " + userId)
		session.users.push({
							id: userId,
							name: "anon"+session.users.length,
							master: null,
							ready: null,
							active: true
						})
	}
	function session_removeUser(session, userId){
		session.users.splice(findWithCode(session.users, userId), 1)
	}

    socket.on('disconnect', function(){
    	// Remove user from session
        var session = findSessionByUserId(socket.id)
        if (session){
        	session_removeUser(session, socket.id)
        	console.log("User " + socket.id + " removed from session " + session.id)
        }
    })
    socket.on('nameChange', function(data){
    	console.log(socket.id + " is changing name to.." + data.newName)
		for (var session in sessions){
			var session = sessions[session]
			for (var i = 0; i < session.users.length; i++){
				if (session.users[i].id == socket.id){
					if (!data.newName){
						data.users[i].name = "anonymous"
					} else {
						session.users[i].name = data.newName
					}
				}
			}
		}
    })
    socket.on("readyChange", function(data){
		for (var session in sessions){
			var session = sessions[session]
			for (var i = 0; i < session.users.length; i++){
				if (session.users[i].id == socket.id){
					session.users[i].ready = data.ready
				}
			}
		}
	})
	socket.on("launchGame", function(data){
		// Autoset launcher user to ready
		for (var session in sessions){
			var session = sessions[session]
			for (var i = 0; i < session.users.length; i++){
				if (session.users[i].id == socket.id){
					session.users[i].ready = true
				}
			}
		}

		var session = findSessionByUserId(socket.id)
		if (checkPlayerReadiness(session)){
			session.state = "voting"
			console.log("session launching :: " + session.id)
			// Create round for session
			var round = {
				players: session.users,
				turn: newTurn(session)
			}
			session.rounds.push(round)
			// Emit informaton about new cards for every player in this session and round
        	for (var j = 0; j < session.users.length; j++){
        		var user = io.sockets.connected[session.users[j].id]
        		user.emit("newCards", {round: session.rounds[0]})

        	}
		} else {
			var user = io.sockets.connected[socket.id]
			user.emit("launchError", {msg: "Players not ready"})
		}
	})
	socket.on("voteCard", function(data){
		var session = findSessionByUserId(socket.id)
		var turn = session.rounds[0].turn
		if (checkVotesForUserId(turn, socket.id)){
			console.log("Voting disabled for you")
			return;
		} else if (turnHasEnded(session.rounds[0])){
			console.log("Turn has ended, can't vote")
			return;
		}
		turn.cards[data.cardId].votes++
		turn.hasVoted.push(socket.id)
		// Update card state for every user in session
		for (var i = 0; i < session.users.length; i++){
	    	// Individual user in specific session
	    	var user = io.sockets.connected[session.users[i].id]
	    	user.emit("updateCardState", {cards: turn.cards})
        }
	})
	socket.on("skipCard", function(){
	})
	socket.on("completeCard", function(){
		var session = findSessionByUserId(socket.id)
		var lastTurn = session.rounds[0].turn
		// Confirm it's player's turn
		var player = session.users[findWithCode(session.users, socket.id)]
		if (playerHasTurn(player, lastTurn)){
	    	intermission_start = getTimestamp()
	    	session.state = "intermission"
		}
	})
    // Goes through all sessions
	setInterval(function() {
	    for (var sessionKey in sessions){
	        var session = sessions[sessionKey];
	        if (session.users.length > 0){
	        	// Goes through every user in this specific session
		        for (var i = 0; i < session.users.length; i++){
		        	// Individual user in specific session
		        	var user = io.sockets.connected[session.users[i].id]
		        	// Session is in lobby
		        	if (session.state == "lobby"){
			        	user.emit("sessionInfo", {session: session, sessionUsers: session.users, personal: session.users[i]})
			        	if (session.users[i].master){
			        		user.emit("master")
			        	}
		        	}
		        	// <!-- Voting.. -->
		        	else if (session.state == "voting"){
		        		var turn = session.rounds[0].turn
			        	var timeLeft = Math.round(TURN_LENGTH - (turn.startTime - getTimestamp()) *-1)
			        	socket.emit("turnTimer", {timeLeft: timeLeft})
			        	// Check if turn has ended
			        	if (turnHasEnded(session.rounds[0])){
			        		session.state = "waitingForTaskCompletion"
			        		for (var j = 0; j < session.users.length; j++){
					    		var user = io.sockets.connected[session.users[j].id]
					    		user.emit("waitingForTaskCompletion", {round: session.rounds[0]})
					    		if (playerHasTurn(user, turn)){
					    			user.emit("completionPending", {})
					    		}
					    	}
			        	}
		        	}
		        	// <-- Game is waiting for players to complete the task given by a card -->
		        	else if (session.state == "waitingForTaskCompletion"){
		        		var turn = session.rounds[0].turn
		        		for (var j = 0; j < session.users.length; j++){
				    		var user = io.sockets.connected[session.users[j].id]
				    		if (playerHasTurn(user, turn)){
				    			user.emit("completionPending", {})
				    		}
				    	}
		        	} // <!-- Short intermissions between turns -->
		        	else if (session.state == "intermission"){
		        		// Get next player for next turn announcement
	        			var lastTurn = session.rounds[0].turn
		        		var nextPlayer = session.users[nextPlayerIndex(session, lastTurn)]
		        		user.emit("intermission", {round: session.rounds[0], nextPlayer: nextPlayer})
		        		if (intermissionHasEnded()){
		        			// Intermission ended, generate new turn
    						session.rounds[0].turn = newTurn(session, lastTurn)
							// Let everyone know
					    	for (var j = 0; j < session.users.length; j++){
					    		var user = io.sockets.connected[session.users[j].id]
					    		user.emit("newCards", {round: session.rounds[0]})
					    	}
					    	// Enter voting phase
		        			session.state = "voting"
		        		}
		        	}
		        }
	        }
	    }
	}, 100);
})
//var ipandport = "http://91.156.236.226:1337"

server.listen(PORT, HOST);
console.log("Up and running at port :: " + PORT)

//server.listen(process.env.PORT || 5000);
//console.log("Up and running at port :: " + process.env.PORT || 5000)
function newTurn(session, lastTurn){
	// First turn's number is 1
	var turnNumber = 1;
	var turnIndex;
	// If was a lastTurn..
	if (lastTurn){
		turnNumber = lastTurn.number++
		// Determine whose turn is next..
		var turnIndex = findWithCode(session.users, lastTurn.player_turn.id)
		if (turnIndex != -1){
			turnIndex++
			if (turnIndex >= session.users.length){
				turnIndex = 0
			}
		}
	} else {
		turnIndex = 0;
	}

	var newTurn = {
		number: turnNumber,
		player_turn: session.users[turnIndex], // Whose turn is it, target for voting cards
		cards: [], // Holds three random cards
		//hasVoted: [session.users[turnIndex].id], // Who has voted this turn, avoid double votes
		hasVoted: [],
		startTime: getTimestamp()// Timestamp in unixtime
	}

	// Generate three cards for this round
	var randomCards = []
	randomCards.push(generateDrinkCard()) 	// First card is always a drink card
	randomCards.push(getRandomCard()) 		// Generate two random cards
	randomCards.push(getRandomCard())

	newTurn.cards = randomCards;
	return newTurn;
}
function getRandomCard(){
	var randomCard = null
	var randomIndex = null
	// Determines if the card is epic, rare or give
	var randomNumber = getRandomInt(0, 100)

	if (randomNumber <= EPIC_CARD_CHANCE){
		randomIndex = getRandomInt(0, epicCards.length-1)
		randomCard = Object.assign({}, epicCards[randomIndex]) // shallow copy from list
	} else if (randomNumber > EPIC_CARD_CHANCE && randomNumber <= RARE_CARD_CHANCE){
		randomIndex = getRandomInt(0, rareCards.length-1)
		randomCard = Object.assign({}, rareCards[randomIndex])
	} else if (randomNumber > RARE_CARD_CHANCE){
		randomCard = generateGiveCard()
	}

	// Do specific card logic
	switch(randomCard.id){
		case 14: // No swearing -rule
			console.log("Removing no-swearing rule -card")
			rareCards.splice(findWithCode(rareCards, 14), 1)
			console.log(rareCards)
			break;
		case 22: // Category card
			// No more categories left..
			if (categories.length < 1){
				randomCard.unlockName = "Any category"
				randomCard.unlockText = "Pick a category and take turns in saying words / phrases / things from that category. The one to mess it all up takes <b>4</b> sips of desired drink."
			} else {
				// Pick random category from a list
				var randomCategoryIndex = getRandomInt(0, categories.length-1)
				randomCard.unlockName = categories[randomCategoryIndex].name
				randomCard.unlockText = categories[randomCategoryIndex].text
				// Remove it to prevent duplicates
				categories.splice(randomCategoryIndex, 1)
			}
			break;
		default:
			break;
	}

	return randomCard
}
function generateGiveCard(){
	var giveDifficulty = POSSIBLE_GIVE_DIFFICULTIES[getRandomInt(0, POSSIBLE_GIVE_DIFFICULTIES.length-1)]
	var giveCard = Object.assign({}, giveCardBase)
	giveCard.text = "Order someone to drink " + giveDifficulty + " sip(s) of desired drink. Can be divided between players."
	giveCard.difficulty = giveDifficulty
	// Epicness ensues
	if (giveDifficulty > 7){
		giveCard.rarity = "Epic Common"
	} else if (giveDifficulty >= 6 && giveDifficulty < 8){
		giveCard.rarity = "Rare Common"
	}
	return giveCard;
}
function generateDrinkCard(){
	var drinkDifficulty = POSSIBLE_DRINK_DIFFICULTIES[getRandomInt(0, POSSIBLE_DRINK_DIFFICULTIES.length-1)]
	var drinkCard = Object.assign({}, drinkCardBase)
	drinkCard.text = "Drink " + drinkDifficulty + " sip(s) of desired drink."
	drinkCard.difficulty = drinkDifficulty
	return drinkCard;
}

var categories = [
	{
		id: 1,
		name: "STD and Pregnancy Prevention",
		text: "Take turns in listing ways to prevent STD's or pregnancy. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 2,
		name: "Condom brands",
		text: "Take turns in listing different brands for condoms. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 3,
		name: "Original pokemons",
		text: "Take turns in listing all the original 151 pokemons. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 4,
		name: "Characters from Friends",
		text: "Take turns in listing all the characters from hit series \"Friends\". The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 5,
		name: "Capital Cities of Europe",
		text: "Take turns in listing all the Capital Cities in Europe. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 6,
		name: "Gods",
		text: "Take turns in listing Gods from different religions. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 7,
		name: "PC-games",
		text: "Take turns in listing different PC-game titles. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
	{
		id: 8,
		name: "Women's clothes",
		text: "Take turns in listing different types of women's clothing. The one to mess it all up takes <b>4</b> sips of desired drink."
	},
]

function nextPlayerIndex(session, lastTurn){
	var turnIndex;
	var turnIndex = findWithCode(session.users, lastTurn.player_turn.id)
	turnIndex++
	if (turnIndex >= session.users.length){
		turnIndex = 0;
	}
	return turnIndex
}

function playerHasTurn(player, turn){
	if (turn.player_turn.id == player.id){
		return true
	} else {
		return false
	}
}
function getTimestamp(){
	return Math.floor(Date.now() / 10)
}
function turnHasEnded(round){
	var turn = round.turn;
	if ((turn.startTime - getTimestamp()) * -1 > TURN_LENGTH){
		return true
	} else if (round.players.length == turn.hasVoted.length){
		return true
	}
	return false
}
function intermissionHasEnded(){
	if ((intermission_start - getTimestamp()) * -1 > INTERMISSION_LENGTH){
		return true
	}
	return false
}
function getWinningCard(cards) {
    var index = 0;
    var topVotes = cards[0].votes;
    for (var i = 1; i < cards.length; ++i) {
        if (cards[i].votes > topVotes || (cards[i].votes === topVotes && Math.random() < 0.5)) {
            index = i;
            topVotes = cards[i].votes;
        }
    }
    return cards[index];
}
function checkPlayerReadiness(session){
	for (var i = 0; i < session.users.length; i++){
		if (!session.users[i].ready){
			return false
		}
	}
	return true
}
function findWithCode(from, id) {
    for (var i = 0; i < from.length; i++) {
        if (from[i].id == id) {
            return i;
        }
    }
    return -1;
}
function findSessionByUserId(userId){
	for (var session in sessions){
		var session = sessions[session]
		for (var i = 0; i < session.users.length; i++){
			if (session.users[i].id == userId){
				return session;
			}
		}
	}
	return false;
}
function checkVotesForUserId(turn, userId){
	for (var voters in turn){
		var voter = turn.hasVoted[voter]
		for (var i = 0; i < turn.hasVoted.length; i++){
			if (turn.hasVoted[i] == userId){
				return true
			}
		}
	}
	return false
}
function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

var drinkCardBase = {
	id: 0,
	name: "Drink",	// Card name
	rarity: "Common",
	text: "Drink " + this.difficulty + " sip(s) of desired drink.", // What it says on the card
	difficulty: null,
	votes: 0	// How many votes it has
}
var giveCardBase = {
	id: 1,
	name: "Give",	// Card name
	rarity: "Common",
	text: "Order someone to drink " + this.difficulty + " sip(s) of desired drink.", // What it says on the card
	difficulty: null,
	votes: 0	// How many votes it has
}

var rareCards = [
	{	id: 12,
		name: "Slap!",	// Card name
		rarity: "Rare",
		text: "Last player to slap his/hers forehead takes <b>4</b> sips of desired drink.", // What it says on the card
		difficulty: 4,
		votes: 0	// How many votes it has
	},
	{
		id: 14,
		name: "It's a child's game",
		rarity: "Rare",
		text: "After this card has been chosen, no swearing is allowed. If someone swears, he/she takes <b>4</b> sips of desired drink.",
		difficulty: 4,
		votes: 0
	},
	{	id: 15,
		name: "Pow",	// Card name
		rarity: "Rare",
		text: "Everyone take <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Lumberjacking",	// Card name
		rarity: "Rare",
		text: "If you don't have a beard or if you are not drinking beer, take <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 0,
		votes: 0	// How many votes it has
	},
	{	id: 17,
		name: "Union",	// Card name
		rarity: "Rare",
		text: "Take <b>4</b> sips of desired drink with the persons next to you.", // What it says on the card
		difficulty: 4,
		votes: 0	// How many votes it has
	},
	{	id: 19,
		name: "Bleed alcohol",	// Card name
		rarity: "Rare",
		text: "For the rest of the game, drink +1 every time you have to drink.", // What it says on the card
		difficulty: 10,
		votes: 0	// How many votes it has
	},
	{	id: 16,
		name: "Beer!",	// Card name
		rarity: "Rare",
		text: "Everyone who's drinking beer tonight will take <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 333,
		name: "Long Drink!",	// Card name
		rarity: "Rare",
		text: "Everyone who's drinking Long Drinks tonight will take <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 331,
		name: "Cider/Wine!",	// Card name
		rarity: "Rare",
		text: "Everyone who's drinking cider or any wine tonight will take <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Rock/Paper/Scissors!",	// Card name
		rarity: "Rare",
		text: "Play rock/paper/scissors with the person on your right side. Loser drinks <b>4</b> sips of desired drink.", // What it says on the card
		difficulty: 4,
		votes: 0	// How many votes it has
	},
	{	id: 22,
		name: "Category card",	// Card name
		rarity: "Rare",
		text: "A category is generated. Take turns in saying words / phrases / things from that category. The person who messes it all up drinks <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Swedish Proficiency",	// Card name
		rarity: "Rare",
		text: "Start a story in swedish with the phrase 'Det var en gång..'. The story has to make sense. The one to mess it all up drinks <b>3</b> sips.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Mute",	// Card name
		rarity: "Rare",
		text: "Player can't talk until his/hers next turn. Talking requires player to drink <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Most likely",	// Card name
		rarity: "Rare",
		text: "\"Who of us has most likely..\": Come up with a most likely question. At the count of three everyone points at the person who fits best to the question. Everyone will take a sip for each person pointing at him/her.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Patriarchy",	// Card name
		rarity: "Rare",
		text: "Men drink <b>5</b> sips of desired drink. Grunting and other manly manners are encouraged.", // What it says on the card
		difficulty: 5,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Matriarchy",	// Card name
		rarity: "Rare",
		text: "Women drink <b>3</b> sips of desired drink. No hurry.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Land of a thousand lakes",	// Card name
		rarity: "Rare",
		text: "Drink a glass of water you poor thing.", // What it says on the card
		difficulty: 0,
		votes: 0	// How many votes it has
	},
	{	id: 24,
		name: "Rhyming",	// Card name
		rarity: "Rare",
		text: "Pick a word and take turns in coming up with sensible rhymes to that word. Messer takes <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 0,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "I never have..",	// Card name
		rarity: "Rare",
		text: "Play the \"I Never Have\"-game. Everyone who <u>HAS</u> has done what you haven't, drink <b>3</b> sips of desired drink. ", // What it says on the card
		difficulty: 0,
		votes: 0	// How many votes it has
	},
	{	id: 29,
		name: "About love",	// Card name
		rarity: "Rare",
		text: "If you have ever been in love with anyone from the other players, drink <b>6</b> sips of desired drink.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	},
	{	id: 35,
		name: "Expensive watch",	// Card name
		rarity: "Rare",
		text: "Everyone who doesn't wear a watch must drink <b>5</b> sips of desired drink.", // What it says on the card
		difficulty: 5,
		votes: 0	// How many votes it has
	},
	{	id: 36,
		name: "Linguist genious",	// Card name
		rarity: "Rare",
		text: "The player on your right side says a difficult word in your mother language. If you can't explain what it means, drink <b>4</b> sips of desired drink.", // What it says on the card
		difficulty: 4,
		votes: 0	// How many votes it has
	},
	{	id: 37,
		name: "Aryan masterrace",	// Card name
		rarity: "Rare",
		text: "All players with blue eyes will drink <b>6</b> sips of desired drink.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	},
	{	id: 39,
		name: "Ditto",	// Card name
		rarity: "Rare",
		text: "Until your next turn mimic the player next to you.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	},
	{	id: 40,
		name: "Most Wanted Drunk",	// Card name
		rarity: "Rare",
		text: "Who do you think is most drunk right now? All players will vote. The selected player will drink <b>6</b> sips of desired drink.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	},
	{	id: 41,
		name: "In your phone",	// Card name
		rarity: "Rare",
		text: "Other players will pick a contact from your phone. You have to tell them all about that person.", // What it says on the card
		difficulty: 4,
		votes: 0	// How many votes it has
	},
	{	id: 42,
		name: "Name game",	// Card name
		rarity: "Rare",
		text: "You must point at every other player in order and say his/hers name. Each time you fail, drink <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 3,
		votes: 0	// How many votes it has
	},
	{	id: 43,
		name: "Friendship secrets",	// Card name
		rarity: "Rare",
		text: "Player picks another player and tells the others all about their relationship and how it started. After that you both drink <b>4</b> sips of desired drink.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	}
]
var epicCards = [
	{	id: 13,
		name: "Waterfall",	// Card name
		rarity: "Epic",
		text: "Everyone take a deep breath and start drinking! You can stop only when the player who gets this card stops drinking.", // What it says on the card
		difficulty: 12,
		votes: 0	// How many votes it has
	},
	{	id: 18,
		name: "Trump card",	// Card name
		rarity: "Epic",
		text: "Finish your drink. No whining.", // What it says on the card
		difficulty: 12,
		votes: 0	// How many votes it has
	},
	{	id: 21,
		name: "Prostitution is legal",	// Card name
		rarity: "Epic",
		text: "Pick a player to be your whore! Your whore always drinks <b>1</b> when you do. Card is cancelled when someone else picks a whore.", // What it says on the card
		difficulty: 2,
		votes: 0	// How many votes it has
	},
	{	id: 20,
		name: "Time to play",	// Card name
		rarity: "Epic",
		text: "Take a shot or finish your drink if you don't have one.", // What it says on the card
		difficulty: 12,
		votes: 0	// How many votes it has
	},
	{	id: 25,
		name: "Custom rule",	// Card name
		rarity: "Epic",
		text: "Come up with a custom rule for the game together. Breaking the rule costs <b>3</b> sips of desired drink.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	},
	{	id: 28,
		name: "It's all about the Butt",	// Card name
		rarity: "Epic",
		text: "Everyone slap dat man ass. Drink for every slap you got on your sweet little bum.", // What it says on the card
		difficulty: 6,
		votes: 0	// How many votes it has
	}
]
