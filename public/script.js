const api = "";

async function fetchStudents(){
  const res = await fetch("/students");
  const data = await res.json();
  const table = document.getElementById("studentsTable");
  table.innerHTML="<tr><th>ID</th><th>Name</th><th>Phone</th></tr>";
  for(const id in data){
    const row = table.insertRow();
    row.insertCell(0).innerText=id;
    row.insertCell(1).innerText=data[id].name;
    row.insertCell(2).innerText=data[id].phone;
  }
}

async function fetchAttendance(){
  const res = await fetch("/attendance");
  const data = await res.json();
  const table = document.getElementById("attendanceTable");
  table.innerHTML="<tr><th>ID</th><th>Timestamps</th></tr>";
  for(const id in data){
    const row = table.insertRow();
    row.insertCell(0).innerText=id;
    row.insertCell(1).innerText=data[id].map(a=>a.timestamp).join(", ");
  }
}

async function setMode(mode){
  const registerID = document.getElementById("registerID").value;
  await fetch("/setMode",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({mode,registerID})});
  alert("Mode set to "+mode);
}

setInterval(fetchStudents,5000);
setInterval(fetchAttendance,5000);
