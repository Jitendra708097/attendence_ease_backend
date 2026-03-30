function validateEmployeePayload(body = {}, isUpdate = false) {
  const details = [];
  const requiredFields = ['name', 'email', 'branchId', 'shiftId', 'role'];

  requiredFields.forEach((field) => {
    if (!isUpdate && !body[field]) {
      details.push({ field, message: `${field} is required` });
    }
  });

  return details;
}

module.exports = {
  validateEmployeePayload,
};
