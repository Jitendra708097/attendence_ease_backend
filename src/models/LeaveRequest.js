module.exports = (sequelize, DataTypes) => {
  const LeaveRequest = sequelize.define(
    'LeaveRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      leave_type: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      from_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      to_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      days_count: DataTypes.DECIMAL(4, 1),
      is_half_day: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      half_day_period: {
        type: DataTypes.ENUM('morning', 'afternoon'),
        allowNull: true,
      },
      reason: DataTypes.TEXT,
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
        defaultValue: 'pending',
      },
      approved_by: DataTypes.UUID,
      approved_at: DataTypes.DATE,
      rejection_reason: DataTypes.TEXT,
    },
    {
      tableName: 'leave_requests',
      paranoid: true,
      underscored: true,
    }
  );

  LeaveRequest.associate = (models) => {
    LeaveRequest.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'approved_by', as: 'approver' });
  };

  return LeaveRequest;
};
