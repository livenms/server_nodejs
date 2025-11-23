async function registerStudent() {
    const fid = document.getElementById("fid").value;
    const name = document.getElementById("name").value;
    const phone = document.getElementById("phone").value;

    const res = await fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid, name, phone })
    });

    const data = await res.json();
    alert(data.message);

    loadStudents();
}

async function loadStudents() {
    const res = await fetch("/students");
    const students = await res.json();

    let html = "<table><tr><th>FID</th><th>Name</th><th>Phone</th></tr>";

    students.forEach(s => {
        html += `<tr><td>${s.fid}</td><td>${s.name}</td><td>${s.phone}</td></tr>`;
    });

    html += "</table>";

    document.getElementById("students").innerHTML = html;
}

async function loadAttendance() {
    const res = await fetch("/attendance");
    const rows = await res.json();

    let html = "<table><tr><th>Name</th><th>Time</th></tr>";

    rows.forEach(a => {
        html += `<tr><td>${a.name}</td><td>${a.timestamp}</td></tr>`;
    });

    html += "</table>";

    document.getElementById("attendance").innerHTML = html;
}

setInterval(loadAttendance, 3000);
setInterval(loadStudents, 3000);
