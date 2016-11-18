function testi(kuka){
	var password = "spermainenkulli"
	$.get("/who?user="+kuka+"&password="+password, function(data){
		$("#jes").append("<h1>"+data+"</h1>")
  	});
}
